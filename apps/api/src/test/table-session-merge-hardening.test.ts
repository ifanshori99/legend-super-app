// gabung meja hardening (legend-mgavf, brief 419). Written before the fix, so
// findings 1 and 2 start red.
//
// 1. A POS tender that is committing while a merge runs must not slip past the
//    merge's payment check. The tender is simulated by a second database
//    connection that holds the row lock of a session's order (what the tender
//    transaction holds while it writes) and commits a captured tender while the
//    merge request waits. The merge must (a) wait for that lock, for orders of
//    BOTH sessions, and (b) then see the tender and refuse with 409.
// 2. An open dearer-swap fee (order_issue_charges, status `open`) rides on the
//    source session. A merge must not strand it on a source session that is
//    closed. Either answer is acceptable (assumption, from the brief): the fee
//    moves to the target session (200), or the merge is refused (409) with
//    everything untouched.
// 3. A partly paid session is still refused with 409; the message the cashier
//    reads must be Indonesian and say it is about paying / merging.
//
// Assumptions: the "tender in flight" is a lock on the order row plus a
// captured pos_order_tenders row committed afterwards (same shape the existing
// review-fix tests seed); a merge that is blocked on that lock shows up as a
// backend blocked by the holder's pid in pg_stat_activity.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { createUlid, idr, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { setTableSessionSettlementLookup } from "../services/table-session.service";
import { qrOrderSettlementLookup } from "../services/qr-order.service";
import { originHeader } from "./helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededOutletA,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers";

let app: Express;
let staff: Awaited<ReturnType<typeof staffWithRole>>;
let zoneId: string;
let categoryId: string;
let menuItemId: string;
const paidIdrBySession = new Map<string, number>();
const zoneIds: string[] = [];
const tableIds: string[] = [];
const posOrderUuids: string[] = [];

// ---- fixtures -------------------------------------------------------------

async function openSession() {
  const table = await createTable(staff.client, { zoneId });
  tableIds.push(table.id);
  const qr = await issueQr(staff.client, table.id);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  return {
    sessionId: scanned.body.data.session.id as string,
    tableId: table.id as string,
  };
}

/** One 'sent' order with one live line, straight into the database. */
async function seedOrder(sessionId: string, unit = 20000) {
  const { rows } = await owner.query<{
    outlet_id: string;
    payment_mode: string;
  }>("SELECT outlet_id, payment_mode FROM table_sessions WHERE id = $1", [
    sessionId,
  ]);
  const session = rows[0]!;
  const uuid = ulidToUuid(createUlid());
  const itemUuid = ulidToUuid(createUlid());
  const today = new Date().toISOString().slice(0, 10);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id,
        payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, prices_include_tax, status, business_date, placed_at, fired_at)
     VALUES ($1, $2, $3, $4, 'qr', 'dine_in', $5, $6, $7, 0, 0, 0, 0, $7, false,
        'sent', $8, now(), now())`,
    [
      uuid,
      seededTenantId,
      session.outlet_id,
      `MRG-${randomUUID().slice(0, 12)}`,
      sessionId,
      session.payment_mode,
      unit,
      today,
    ],
  );
  await owner.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
        quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
        fire_status, status, reserved_business_date)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Item 1', 1, $6, 0, $6, '[]'::jsonb,
        'fired', 'queued', $7)`,
    [
      itemUuid,
      seededTenantId,
      session.outlet_id,
      uuid,
      menuItemId,
      unit,
      today,
    ],
  );
  return { uuid, itemUuid };
}

/** A POS-channel order in the session that has no tender yet. */
async function seedPosOrderWithoutTender(sessionId: string) {
  const order = await seedOrder(sessionId, 30000);
  posOrderUuids.push(order.uuid);
  await owner.query("UPDATE orders SET channel = 'pos' WHERE id = $1", [
    order.uuid,
  ]);
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
     SELECT id, tenant_id, outlet_id, channel FROM orders WHERE id = $1`,
    [order.uuid],
  );
  return order;
}

/** An open dearer-swap fee on `sessionId`, attached to `order`. */
async function seedOpenSwapFee(
  sessionId: string,
  order: { uuid: string; itemUuid: string },
) {
  const issueId = randomUUID();
  const chargeId = randomUUID();
  const { rows } = await owner.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM table_sessions WHERE id = $1",
    [sessionId],
  );
  const outletId = rows[0]!.outlet_id;
  await owner.query(
    `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
        reason_note, reported_by, cost_idr, idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Stok habis', $6, 0, $7, 'open')`,
    [
      issueId,
      seededTenantId,
      outletId,
      order.uuid,
      order.itemUuid,
      staff.userId,
      `merge-fee-${issueId}`,
    ],
  );
  // 6.000 difference + 300 service + 630 PBJT = 6.930.
  await owner.query(
    `INSERT INTO order_issue_charges
       (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
        difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', 'open', 6000, 6000, 300, 630, 6930)`,
    [chargeId, seededTenantId, outletId, issueId, order.uuid, sessionId],
  );
  return chargeId;
}

async function chargeSession(chargeId: string): Promise<string | null> {
  const { rows } = await owner.query<{ table_session_id: string | null }>(
    "SELECT table_session_id FROM order_issue_charges WHERE id = $1",
    [chargeId],
  );
  return rows[0]!.table_session_id;
}

async function orderSession(orderUuid: string): Promise<string | null> {
  const { rows } = await owner.query<{ table_session_id: string | null }>(
    "SELECT table_session_id FROM orders WHERE id = $1",
    [orderUuid],
  );
  return rows[0]!.table_session_id;
}

async function sessionStatus(sessionId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM table_sessions WHERE id = $1",
    [sessionId],
  );
  return rows[0]!.status;
}

const moveItems = (
  fromSessionId: string,
  toSessionId: string,
  orderItemIds: string[],
) =>
  staff.client
    .post(`/api/table-sessions/${fromSessionId}/move-items`)
    .set(originHeader)
    .send({ toSessionId, orderItemIds });

const merge = (targetId: string, sourceSessionId: string) =>
  staff.client
    .post(`/api/table-sessions/${targetId}/merge`)
    .set(originHeader)
    .send({ sourceSessionId });

async function twoSessions() {
  const target = await openSession();
  const source = await openSession();
  const targetOrder = await seedOrder(target.sessionId, 20000);
  const sourceOrder = await seedOrder(source.sessionId, 15000);
  return { target, source, targetOrder, sourceOrder };
}

/** Poll until some backend waits on a lock held by `holderPid`. */
async function mergeIsBlockedBy(
  holderPid: number,
  settled: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !settled()) {
    const { rows } = await owner.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
       ) AS blocked`,
      [holderPid],
    );
    if (rows[0]!.blocked) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// ---- lifecycle ------------------------------------------------------------

beforeAll(async () => {
  app = createApp();
  setTableSessionSettlementLookup(async (input) => {
    const real = await qrOrderSettlementLookup(input);
    const paid = paidIdrBySession.get(input.sessionId);
    if (real === null || paid === undefined) return real;
    return { billTotalIdr: real.billTotalIdr, paidIdr: idr(paid) };
  });
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Merge Hardening Owner",
  });
  const zone = await createZone(staff.client, {
    hours: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
    ],
  });
  zoneId = zone.id;
  zoneIds.push(zoneId);
  const { rows } = await owner.query<{ brand_id: string }>(
    "SELECT brand_id FROM outlets WHERE id = $1",
    [seededOutletA],
  );
  const brandId = rows[0]!.brand_id;
  categoryId = randomUUID();
  menuItemId = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Gabung Meja Uji', 0)`,
    [categoryId, seededTenantId, brandId],
  );
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Gabung', true, $5)`,
    [menuItemId, seededTenantId, brandId, categoryId, randomUUID()],
  );
});

beforeEach(() => {
  paidIdrBySession.clear();
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  const orderScope = `SELECT id FROM orders WHERE tenant_id = $1 AND table_session_id IN
      (SELECT id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2))`;
  await owner.query(
    `DELETE FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
    [seededTenantId, posOrderUuids],
  );
  await owner.query(
    `DELETE FROM pos_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
    [seededTenantId, posOrderUuids],
  );
  await owner.query(
    `DELETE FROM order_issue_charges WHERE tenant_id = $1 AND order_id IN (${orderScope})`,
    [seededTenantId, tableIds],
  );
  await owner.query(
    `DELETE FROM order_issues WHERE tenant_id = $1 AND order_id IN (${orderScope})`,
    [seededTenantId, tableIds],
  );
  await owner.query(
    `DELETE FROM order_items WHERE tenant_id = $1 AND order_id IN (${orderScope})`,
    [seededTenantId, tableIds],
  );
  await owner.query(
    `DELETE FROM orders WHERE tenant_id = $1 AND table_session_id IN
      (SELECT id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2))`,
    [seededTenantId, tableIds],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.query("DELETE FROM menu_items WHERE id = $1", [menuItemId]);
  await owner.query("DELETE FROM menu_categories WHERE id = $1", [categoryId]);
  await owner.end();
});

// ===========================================================================
// Finding 1: payment check must happen under the order locks
// ===========================================================================

describe("merge versus a POS tender in flight (legend-mgavf finding 1)", () => {
  it.each(["source", "target"] as const)(
    "waits for a tender committing on the %s session and then refuses the merge",
    async (side) => {
      const { target, source } = await twoSessions();
      const sourceOrder = await seedOrder(source.sessionId, 18000);
      const posSession = side === "source" ? source : target;
      const posOrder = await seedPosOrderWithoutTender(posSession.sessionId);

      // The "tender": holds the order's row lock, writes a captured tender,
      // commits only after the merge request is waiting.
      const holder: PoolClient = await owner.connect();
      let response: Awaited<ReturnType<typeof merge>> | undefined;
      let blocked = false;
      try {
        await holder.query("BEGIN");
        const pid = (
          await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        await holder.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
          posOrder.uuid,
        ]);

        let done = false;
        const pending = merge(target.sessionId, source.sessionId).then(
          (res) => {
            done = true;
            return res;
          },
        );
        blocked = await mergeIsBlockedBy(pid, () => done);

        await holder.query(
          `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
              amount_idr, status, requested_at, resolved_at)
           SELECT tenant_id, outlet_id, id, 'card', 'manual', 30000, 'captured', now(), now()
           FROM orders WHERE id = $1`,
          [posOrder.uuid],
        );
        await holder.query("COMMIT");
        response = await pending;
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }

      // (a) the merge did not run past the in-flight tender's lock.
      expect(
        blocked,
        `merge did not wait for the order lock of the ${side} session`,
      ).toBe(true);
      // (b) once the tender committed, the merge saw it and refused.
      expect(response!.status, JSON.stringify(response!.body)).toBe(409);
      expect(await sessionStatus(source.sessionId)).toBe("open");
      expect(await orderSession(sourceOrder.uuid)).toBe(source.sessionId);
      expect(await orderSession(posOrder.uuid)).toBe(posSession.sessionId);
    },
  );
});

// ===========================================================================
// Finding 2: an open swap-difference fee must not be lost on merge
// ===========================================================================

describe("merge with an open swap-difference fee (legend-mgavf finding 2)", () => {
  it("moves the open fee to the target session, or refuses the merge; never strands it on the closed source", async () => {
    const { target, source, sourceOrder } = await twoSessions();
    const chargeId = await seedOpenSwapFee(source.sessionId, sourceOrder);

    const response = await merge(target.sessionId, source.sessionId);

    if (response.status === 200) {
      expect(await sessionStatus(source.sessionId)).toBe("closed");
      expect(
        await chargeSession(chargeId),
        "open fee still points at the voided source session",
      ).toBe(target.sessionId);
    } else {
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await sessionStatus(source.sessionId)).toBe("open");
      expect(await chargeSession(chargeId)).toBe(source.sessionId);
      expect(await orderSession(sourceOrder.uuid)).toBe(source.sessionId);
    }
  });

  it("keeps the fee billable: after a merge the fee never sits on a closed session", async () => {
    const { target, source, sourceOrder } = await twoSessions();
    const chargeId = await seedOpenSwapFee(source.sessionId, sourceOrder);

    await merge(target.sessionId, source.sessionId);

    const owning = await chargeSession(chargeId);
    expect(owning).not.toBeNull();
    expect(
      await sessionStatus(owning!),
      "the session that owns the open fee must still be running",
    ).not.toBe("closed");
  });
});

// ===========================================================================
// Finding 3: partly paid session, clear Indonesian refusal
// ===========================================================================

describe("merge of a partly paid session (legend-mgavf finding 3)", () => {
  it.each(["source", "target"] as const)(
    "refuses with 409 and a cashier-readable Indonesian message when the %s is partly paid",
    async (side) => {
      const pair = await twoSessions();
      const paid = side === "source" ? pair.source : pair.target;
      paidIdrBySession.set(paid.sessionId, 5000);

      const response = await merge(
        pair.target.sessionId,
        pair.source.sessionId,
      );

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      const message = String(response.body.error?.message ?? "");
      // Says what happened (payment already made) and what was refused (gabung).
      expect(message).toMatch(/bayar|pembayaran/i);
      expect(message).toMatch(/gabung/i);
      expect(message).not.toMatch(/\b(payment|already|cannot|merge)\b/i);
      expect(await sessionStatus(pair.source.sessionId)).toBe("open");
    },
  );
});

// ===========================================================================
// Finding 4 (legend-mgavf, extra): item move versus a POS tender in flight
// ===========================================================================
//
// Same shape as finding 1, for "pindah item". A tender committing on an order
// of either session while items are moved must not slip past the payment
// check: the move has to wait for that order's lock and then be refused with
// 409, with every item still where it was.
//
// Assumption (from the brief): a session with a captured tender counts as
// "already paid" for an item move, like for a merge, so the move is refused
// with 409.

describe("item move versus a POS tender in flight (legend-mgavf item move)", () => {
  const cases = [
    {
      name: "the order being moved (source session)",
      pos: "source",
      moveThePosOrder: true,
    },
    {
      name: "another order of the source session",
      pos: "source",
      moveThePosOrder: false,
    },
    {
      name: "an order of the destination session",
      pos: "destination",
      moveThePosOrder: false,
    },
  ] as const;

  it.each(cases)(
    "waits for a tender committing on $name and then refuses with 409",
    async ({ pos, moveThePosOrder }) => {
      const { target: destination, source } = await twoSessions();
      const plainSourceOrder = await seedOrder(source.sessionId, 18000);
      const posSession = pos === "source" ? source : destination;
      const posOrder = await seedPosOrderWithoutTender(posSession.sessionId);
      const movedOrder = moveThePosOrder ? posOrder : plainSourceOrder;

      // The "tender": holds the order's row lock, writes a captured tender,
      // commits only after the move request is waiting.
      const holder: PoolClient = await owner.connect();
      let response: Awaited<ReturnType<typeof moveItems>> | undefined;
      let blocked = false;
      try {
        await holder.query("BEGIN");
        const pid = (
          await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        await holder.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
          posOrder.uuid,
        ]);

        let done = false;
        const pending = moveItems(source.sessionId, destination.sessionId, [
          uuidToUlid(movedOrder.itemUuid),
        ]).then((res) => {
          done = true;
          return res;
        });
        blocked = await mergeIsBlockedBy(pid, () => done);

        await holder.query(
          `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
              amount_idr, status, requested_at, resolved_at)
           SELECT tenant_id, outlet_id, id, 'card', 'manual', 30000, 'captured', now(), now()
           FROM orders WHERE id = $1`,
          [posOrder.uuid],
        );
        await holder.query("COMMIT");
        response = await pending;
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }

      // (a) the move did not run past the in-flight tender's lock.
      expect(
        blocked,
        `item move did not wait for the order lock (${pos} side)`,
      ).toBe(true);
      // (b) once the tender committed, the move saw it and refused.
      expect(response!.status, JSON.stringify(response!.body)).toBe(409);
      expect(String(response!.body.error?.message)).toMatch(/dibayar sebagian/);
      expect(await orderSession(movedOrder.uuid)).toBe(source.sessionId);
      expect(await orderSession(posOrder.uuid)).toBe(posSession.sessionId);
    },
  );
});
