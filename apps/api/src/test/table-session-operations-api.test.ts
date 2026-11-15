// WS-03 table operations: pindah meja (move), gabung meja (merge) and pindah
// item (move-items) on a table session (legend-685n; PRD v1.7 §3 "9. Denah &
// Meja" Operasi Meja; contract packages/shared/src/qr-order/table-operations.ts).
//
// Real Express app + Better Auth + RBAC + PostgreSQL (disposable server from
// `pnpm test`). Orders are seeded directly in SQL (superuser pool, bypasses RLS);
// the bill comes from the REAL qrOrderSettlementLookup, wrapped so a test can
// declare "paid" money per session (no payment rows exist in this fixture).
//
// Assumptions where the brief is silent:
// - A session's bill is the sum of total_idr of its non-voided orders.
// - Event/audit rows are matched by event name/action plus the id of the
//   session in the URL appearing anywhere in the stored event JSON, so the
//   test does not depend on which payload field carries it.
// - Order item ids travel as ULID strings in the API and as UUIDs in SQL.
// - Invalid body (empty orderItemIds) answers 400 or 422.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  createUlid,
  idr,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createFloorZone,
  createTable as createTableService,
  issueTableQr,
} from "../services/floor.service";
import { setTableSessionSettlementLookup } from "../services/table-session.service";
import { qrOrderSettlementLookup } from "../services/qr-order.service";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  issueQr,
  owner,
  scan,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers";

let app: Express;
let staff: Awaited<ReturnType<typeof staffWithRole>>;
let isolated: IsolatedTenant | null = null;
let payFirstZoneId: string;
let openBillZoneId: string;
let categoryId: string;
let menuItemId: string;
/** Money a test declares as already paid, per session id. */
const paidIdrBySession = new Map<string, number>();
const zoneIds: string[] = [];
const tableIds: string[] = [];

function tenantContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

// ---- fixtures -------------------------------------------------------------

async function newTable(zoneId = payFirstZoneId) {
  const table = await createTable(staff.client, { zoneId });
  tableIds.push(table.id);
  const qr = await issueQr(staff.client, table.id);
  return { table, tableId: table.id as string, token: qr.token as string };
}

/** A table nobody sits at: status `available`, no session. */
async function emptyTable(zoneId = payFirstZoneId) {
  return (await newTable(zoneId)).tableId;
}

/** Scan a fresh table; an open-bill session is confirmed so it is `open`. */
async function openSession(zoneId = payFirstZoneId) {
  const { tableId, token } = await newTable(zoneId);
  const scanned = await scan(app, { token });
  expect(scanned.status).toBe(201);
  const sessionId = scanned.body.data.session.id as string;
  if (scanned.body.data.session.status === "pending_confirmation") {
    const confirmed = await staff.client
      .post(`/api/table-sessions/${sessionId}/confirm`)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
  }
  return { sessionId, tableId };
}

async function setSessionStatus(
  sessionId: string,
  status: "bill_requested" | "voided",
) {
  if (status === "bill_requested")
    await owner.query(
      "UPDATE table_sessions SET status = 'bill_requested', bill_requested_at = now() WHERE id = $1",
      [sessionId],
    );
  else
    await owner.query(
      "UPDATE table_sessions SET status = 'voided', closed_at = now(), closed_reason = 'voided' WHERE id = $1",
      [sessionId],
    );
}

type Line = {
  quantity: number;
  unit: number;
  modifiers?: number;
  voided?: boolean;
};
type SeededItem = {
  id: string;
  uuid: string;
  lineTotal: number;
  voided: boolean;
};
type SeededOrder = { id: string; uuid: string; items: SeededItem[] };

/** Insert one order with its lines straight into the database. */
async function seedOrder(
  sessionId: string,
  lines: Line[],
  components: {
    discount?: number;
    service?: number;
    tax?: number;
    paymentLink?: boolean;
  } = {},
): Promise<SeededOrder> {
  const { rows } = await owner.query<{
    outlet_id: string;
    payment_mode: string;
  }>("SELECT outlet_id, payment_mode FROM table_sessions WHERE id = $1", [
    sessionId,
  ]);
  const session = rows[0];
  if (!session) throw new Error(`No session ${sessionId}`);
  const id = createUlid();
  const uuid = ulidToUuid(id);
  const items: SeededItem[] = lines.map((line) => {
    const itemId = createUlid();
    return {
      id: itemId,
      uuid: ulidToUuid(itemId),
      lineTotal: (line.unit + (line.modifiers ?? 0)) * line.quantity,
      voided: line.voided === true,
    };
  });
  const subtotal = items
    .filter((item) => !item.voided)
    .reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = components.discount ?? 0;
  const service = components.service ?? 0;
  const tax = components.tax ?? 0;
  const total = subtotal - discount + service + tax;
  // A 'sent' order has fired to the kitchen (fired_at set); the service refuses
  // to split an order that has not fired yet.
  const today = new Date().toISOString().slice(0, 10);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id,
        payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, prices_include_tax, status, business_date, placed_at, fired_at,
        payment_link_id, payment_link_token_sealed)
     VALUES ($1, $2, $3, $4, 'qr', 'dine_in', $5, $6, $7, $8, $9, $10, 0, $11, false,
        'sent', $12, now(), now(), $13, $14)`,
    [
      uuid,
      seededTenantId,
      session.outlet_id,
      `OPS-${randomUUID().slice(0, 12)}`,
      sessionId,
      session.payment_mode,
      subtotal,
      discount,
      service,
      tax,
      total,
      today,
      components.paymentLink ? randomUUID() : null,
      components.paymentLink ? "sealed-test-token" : null,
    ],
  );
  for (const [index, item] of items.entries()) {
    const line = lines[index]!;
    await owner.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, '[]'::jsonb, 'fired', $11, $12)`,
      [
        item.uuid,
        seededTenantId,
        session.outlet_id,
        uuid,
        menuItemId,
        `Item ${index + 1}`,
        line.quantity,
        line.unit,
        line.modifiers ?? 0,
        item.lineTotal,
        item.voided ? "voided" : "queued",
        today,
      ],
    );
  }
  return { id, uuid, items };
}

// ---- read helpers ---------------------------------------------------------

async function billOf(sessionId: string): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT COALESCE(sum(total_idr), 0)::bigint::float8 AS total FROM orders
     WHERE tenant_id = $1 AND table_session_id = $2 AND status <> 'voided'`,
    [seededTenantId, sessionId],
  );
  return Number(rows[0]?.total ?? 0);
}

type OrderRow = {
  id: string;
  table_session_id: string | null;
  subtotal: number;
  discount: number;
  service: number;
  tax: number;
  rounding: number;
  total: number;
};

async function ordersOf(sessionId: string): Promise<OrderRow[]> {
  const { rows } = await owner.query<OrderRow>(
    `SELECT id, table_session_id, subtotal_idr::int AS subtotal, discount_idr::int AS discount,
            service_charge_idr::int AS service, tax_idr::int AS tax,
            rounding_idr::int AS rounding, total_idr::int AS total
     FROM orders WHERE tenant_id = $1 AND table_session_id = $2 ORDER BY created_at, id`,
    [seededTenantId, sessionId],
  );
  return rows;
}

async function orderRow(orderUuid: string): Promise<OrderRow> {
  const { rows } = await owner.query<OrderRow>(
    `SELECT id, table_session_id, subtotal_idr::int AS subtotal, discount_idr::int AS discount,
            service_charge_idr::int AS service, tax_idr::int AS tax,
            rounding_idr::int AS rounding, total_idr::int AS total
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [seededTenantId, orderUuid],
  );
  return rows[0]!;
}

/** Session id an item currently belongs to (through its order). */
async function sessionOfItem(itemUuid: string): Promise<string | null> {
  const { rows } = await owner.query<{ table_session_id: string | null }>(
    `SELECT o.table_session_id FROM order_items i
     JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [seededTenantId, itemUuid],
  );
  return rows[0] ? rows[0].table_session_id : null;
}

async function itemExists(itemUuid: string): Promise<boolean> {
  const { rows } = await owner.query(
    "SELECT 1 FROM order_items WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, itemUuid],
  );
  return rows.length === 1;
}

async function sessionRow(sessionId: string) {
  const { rows } = await owner.query<{
    status: string;
    table_id: string;
    closed_reason: string | null;
  }>(
    "SELECT status, table_id, closed_reason FROM table_sessions WHERE id = $1",
    [sessionId],
  );
  return rows[0]!;
}

async function tableStatus(tableId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM tables WHERE id = $1",
    [tableId],
  );
  return rows[0]!.status;
}

async function eventCounts(name: string, sessionId: string) {
  const { rows: outbox } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3::text || '%'`,
    [seededTenantId, name, sessionId],
  );
  const { rows: audit } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event::text LIKE '%' || $3::text || '%'`,
    [seededTenantId, name, sessionId],
  );
  return { outbox: outbox[0]!.count, audit: audit[0]!.count };
}

async function expectEventsAdded(
  name: string,
  sessionId: string,
  before: { outbox: number; audit: number },
  added: number,
) {
  const after = await eventCounts(name, sessionId);
  expect(after.outbox).toBe(before.outbox + added);
  expect(after.audit).toBe(before.audit + added);
}

// ---- requests -------------------------------------------------------------

const move = (sessionId: string, toTableId: string, client = staff.client) =>
  client
    .post(`/api/table-sessions/${sessionId}/move`)
    .set(originHeader)
    .send({ toTableId });
const merge = (
  targetId: string,
  sourceSessionId: string,
  client = staff.client,
) =>
  client
    .post(`/api/table-sessions/${targetId}/merge`)
    .set(originHeader)
    .send({ sourceSessionId });
const moveItems = (
  fromId: string,
  toSessionId: string,
  orderItemIds: string[],
  client = staff.client,
) =>
  client
    .post(`/api/table-sessions/${fromId}/move-items`)
    .set(originHeader)
    .send({ toSessionId, orderItemIds });

/** A session (and a free table) in outlet B, outside outlet A's scope. */
async function outletBFixtures() {
  const zone = await createFloorZone(
    tenantContext(),
    seededOutletB,
    {
      name: `Ops B ${randomUUID().slice(0, 6)}`,
      paymentMode: "pay_first",
      serviceChargeBp: 0,
      minimumSpendIdr: idr(0),
      hours: [
        { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
      ],
      status: "active",
      sortOrder: 3,
    },
    staff.userId,
  );
  zoneIds.push(zone.id);
  const makeTable = async () => {
    const table = await createTableService(
      tenantContext(),
      {
        zoneId: zone.id,
        code: `B-${randomUUID().slice(0, 5)}`.toUpperCase(),
        capacity: 2,
        type: "bar",
        layout: {
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          rotation: 0,
          shape: "rect",
        },
        status: "available",
      },
      staff.userId,
    );
    tableIds.push(table.id);
    return table.id as string;
  };
  const seatedTableId = await makeTable();
  const qr = await issueTableQr(tenantContext(), seatedTableId, staff.userId);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  return {
    sessionId: scanned.body.data.session.id as string,
    freeTableId: await makeTable(),
  };
}

// ---- lifecycle ------------------------------------------------------------

beforeAll(async () => {
  app = createApp();
  // The real bill; only "paid" is overridden per session (no payment rows).
  setTableSessionSettlementLookup(async (input) => {
    const real = await qrOrderSettlementLookup(input);
    const paid = paidIdrBySession.get(input.sessionId);
    if (real === null || paid === undefined) return real;
    return { billTotalIdr: real.billTotalIdr, paidIdr: idr(paid) };
  });
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Operations Owner",
  });
  const payFirst = await createZone(staff.client, {
    hours: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
    ],
  });
  const openBill = await createZone(staff.client, {
    paymentMode: "open_bill",
    hours: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
    ],
  });
  payFirstZoneId = payFirst.id;
  openBillZoneId = openBill.id;
  zoneIds.push(payFirstZoneId, openBillZoneId);
  const { rows: outletRows } = await owner.query<{ brand_id: string }>(
    "SELECT brand_id FROM outlets WHERE id = $1",
    [seededOutletA],
  );
  const brandId = outletRows[0]!.brand_id;
  categoryId = randomUUID();
  menuItemId = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Operasi Meja Uji', 0)`,
    [categoryId, seededTenantId, brandId],
  );
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Operasi', true, $5)`,
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
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

// ===========================================================================
// 1. MOVE (pindah meja)
// ===========================================================================

describe("move table session (legend-685n)", () => {
  it("moves an open session and its bill to an empty table, flipping both table states", async () => {
    const { sessionId, tableId: fromTableId } = await openSession();
    const first = await seedOrder(sessionId, [{ quantity: 2, unit: 15000 }], {
      discount: 3000,
      service: 1500,
    });
    await seedOrder(sessionId, [{ quantity: 1, unit: 40000 }]);
    const billBefore = await billOf(sessionId);
    expect(billBefore).toBeGreaterThan(0);
    const toTableId = await emptyTable();
    expect(await tableStatus(toTableId)).toBe("available");
    const before = await eventCounts("table_session.moved", sessionId);

    const response = await move(sessionId, toTableId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.session.id).toBe(sessionId);
    expect(response.body.data.session.tableId).toBe(toTableId);
    expect(response.body.data.session.status).toBe("open");
    expect(response.body.data.fromTable.id).toBe(fromTableId);
    expect(response.body.data.fromTable.status).toBe("dirty");
    expect(response.body.data.toTable.id).toBe(toTableId);
    expect(response.body.data.toTable.status).toBe("occupied");
    expect((await sessionRow(sessionId)).table_id).toBe(toTableId);
    expect(await tableStatus(fromTableId)).toBe("dirty");
    expect(await tableStatus(toTableId)).toBe("occupied");
    // Orders stay with the session, and the bill does not change.
    expect((await orderRow(first.uuid)).table_session_id).toBe(sessionId);
    expect(await billOf(sessionId)).toBe(billBefore);
    await expectEventsAdded("table_session.moved", sessionId, before, 1);
  });

  it("moves a session that asked for the bill and keeps its status", async () => {
    const { sessionId } = await openSession();
    await seedOrder(sessionId, [{ quantity: 1, unit: 25000 }]);
    await setSessionStatus(sessionId, "bill_requested");
    const toTableId = await emptyTable();

    const response = await move(sessionId, toTableId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.session.status).toBe("bill_requested");
    expect(response.body.data.session.tableId).toBe(toTableId);
  });

  it("allows a partly paid session to move but refuses a fully paid bill", async () => {
    const partial = await openSession();
    await seedOrder(partial.sessionId, [{ quantity: 2, unit: 20000 }]);
    paidIdrBySession.set(partial.sessionId, 10000);
    const partialTarget = await emptyTable();
    const moved = await move(partial.sessionId, partialTarget);
    expect(moved.status).toBe(200);
    expect(moved.body.data.session.tableId).toBe(partialTarget);

    // Open bill: a fully paid bill is settled, so it does not move. (A fully
    // paid pay-first session may move: see the review fixes below.)
    const paid = await openSession(openBillZoneId);
    await seedOrder(paid.sessionId, [{ quantity: 2, unit: 20000 }]);
    paidIdrBySession.set(paid.sessionId, 40000);
    const paidTarget = await emptyTable(openBillZoneId);
    const before = await eventCounts("table_session.moved", paid.sessionId);
    const refused = await move(paid.sessionId, paidTarget);
    expect(refused.status).toBe(409);
    expect((await sessionRow(paid.sessionId)).table_id).toBe(paid.tableId);
    expect(await tableStatus(paidTarget)).toBe("available");
    await expectEventsAdded("table_session.moved", paid.sessionId, before, 0);
  });

  it("refuses a session that is pending confirmation, closed or voided", async () => {
    const pendingTable = await newTable(openBillZoneId);
    const pending = await scan(app, { token: pendingTable.token });
    expect(pending.body.data.session.status).toBe("pending_confirmation");
    const openBillTarget = await emptyTable(openBillZoneId);
    expect(
      (await move(pending.body.data.session.id, openBillTarget)).status,
    ).toBe(409);

    const closed = await openSession();
    const close = await staff.client
      .post(`/api/table-sessions/${closed.sessionId}/close`)
      .set(originHeader)
      .send({ tableCleaned: true, waiterConfirmedEmpty: true });
    expect(close.status).toBe(200);
    expect((await move(closed.sessionId, await emptyTable())).status).toBe(409);

    const voided = await openSession();
    await setSessionStatus(voided.sessionId, "voided");
    expect((await move(voided.sessionId, await emptyTable())).status).toBe(409);
  });

  it("refuses a target table that is occupied, dirty, has an active session, or sits in another zone mode or outlet", async () => {
    const { sessionId, tableId: fromTableId } = await openSession();
    await seedOrder(sessionId, [{ quantity: 1, unit: 10000 }]);
    const before = await eventCounts("table_session.moved", sessionId);

    // Occupied by another session.
    const other = await openSession();
    expect((await move(sessionId, other.tableId)).status).toBe(409);

    // Dirty table.
    const dirtyId = await emptyTable();
    await owner.query("UPDATE tables SET status = 'dirty' WHERE id = $1", [
      dirtyId,
    ]);
    expect((await move(sessionId, dirtyId)).status).toBe(409);

    // A table marked available while a session is still active on it.
    const stale = await openSession();
    await owner.query("UPDATE tables SET status = 'available' WHERE id = $1", [
      stale.tableId,
    ]);
    expect((await move(sessionId, stale.tableId)).status).toBe(409);

    // Zone with a different payment mode than the session's.
    const openBillTable = await emptyTable(openBillZoneId);
    expect((await move(sessionId, openBillTable)).status).toBe(409);

    // A table in another outlet.
    const outletB = await outletBFixtures();
    expect((await move(sessionId, outletB.freeTableId)).status).toBe(409);

    // Nothing moved, nothing recorded.
    expect((await sessionRow(sessionId)).table_id).toBe(fromTableId);
    expect(await tableStatus(fromTableId)).toBe("occupied");
    await expectEventsAdded("table_session.moved", sessionId, before, 0);
  });

  it("repeating the same move answers 200 with the same body and records nothing twice", async () => {
    const { sessionId } = await openSession();
    await seedOrder(sessionId, [{ quantity: 1, unit: 30000 }]);
    const toTableId = await emptyTable();
    const before = await eventCounts("table_session.moved", sessionId);

    const first = await move(sessionId, toTableId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await move(sessionId, toTableId);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await tableStatus(toTableId)).toBe("occupied");
    await expectEventsAdded("table_session.moved", sessionId, before, 1);
  });
});

// ===========================================================================
// 2. MERGE (gabung meja)
// ===========================================================================

describe("merge table sessions (legend-685n)", () => {
  async function twoSessions() {
    const target = await openSession();
    const source = await openSession();
    const targetOrders = [
      await seedOrder(target.sessionId, [{ quantity: 2, unit: 20000 }], {
        discount: 4000,
        service: 2000,
      }),
      await seedOrder(target.sessionId, [{ quantity: 1, unit: 35000 }]),
    ];
    const sourceOrders = [
      await seedOrder(
        source.sessionId,
        [
          { quantity: 3, unit: 10000, modifiers: 2000 },
          { quantity: 1, unit: 99000, voided: true },
        ],
        { discount: 6000, service: 1800 },
      ),
      await seedOrder(source.sessionId, [{ quantity: 2, unit: 12500 }]),
    ];
    return { target, source, targetOrders, sourceOrders };
  }

  it("moves every source order into the target bill and voids the source session", async () => {
    const { target, source, sourceOrders } = await twoSessions();
    const targetBefore = await billOf(target.sessionId);
    const sourceBefore = await billOf(source.sessionId);
    const discountsBefore = await Promise.all(
      sourceOrders.map(async (order) => (await orderRow(order.uuid)).discount),
    );
    const liveItems = sourceOrders
      .flatMap((order) => order.items)
      .filter((item) => !item.voided);
    const before = await eventCounts("table_session.merged", target.sessionId);

    const response = await merge(target.sessionId, source.sessionId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.target.id).toBe(target.sessionId);
    expect(response.body.data.source.id).toBe(source.sessionId);
    expect(response.body.data.source.status).toBe("closed");
    expect(response.body.data.source.closedReason).toBe("voided");
    // Live items only: the voided line is not counted.
    expect(response.body.data.movedItemCount).toBe(liveItems.length);
    expect(response.body.data.movedTotalIdr).toBe(sourceBefore);
    for (const order of sourceOrders)
      expect((await orderRow(order.uuid)).table_session_id).toBe(
        target.sessionId,
      );
    expect(await billOf(target.sessionId)).toBe(targetBefore + sourceBefore);
    expect(await billOf(source.sessionId)).toBe(0);
    // A partial discount stays on the order that carries it.
    expect(
      await Promise.all(
        sourceOrders.map(
          async (order) => (await orderRow(order.uuid)).discount,
        ),
      ),
    ).toEqual(discountsBefore);
    const sourceSession = await sessionRow(source.sessionId);
    expect(sourceSession.status).toBe("closed");
    expect(sourceSession.closed_reason).toBe("voided");
    expect((await sessionRow(target.sessionId)).status).toBe("open");
    // The source table has no session of its own any more; "dirty" keeps a
    // rescan of its QR from opening a second bill until staff free it (ORD-10).
    expect(await tableStatus(source.tableId)).toBe("dirty");
    expect(await tableStatus(target.tableId)).toBe("occupied");
    await expectEventsAdded(
      "table_session.merged",
      target.sessionId,
      before,
      1,
    );
  });

  it("merges sessions that asked for the bill", async () => {
    const { target, source } = await twoSessions();
    await setSessionStatus(target.sessionId, "bill_requested");
    await setSessionStatus(source.sessionId, "bill_requested");
    const response = await merge(target.sessionId, source.sessionId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.target.status).toBe("bill_requested");
  });

  it("repeating the same merge answers 200 with the same counts and records nothing twice", async () => {
    const { target, source } = await twoSessions();
    const before = await eventCounts("table_session.merged", target.sessionId);

    const first = await merge(target.sessionId, source.sessionId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const billAfterFirst = await billOf(target.sessionId);
    const again = await merge(target.sessionId, source.sessionId);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.movedItemCount).toBe(first.body.data.movedItemCount);
    expect(again.body.data.movedTotalIdr).toBe(first.body.data.movedTotalIdr);
    expect(again.body.data.source.id).toBe(source.sessionId);
    expect(await billOf(target.sessionId)).toBe(billAfterFirst);
    await expectEventsAdded(
      "table_session.merged",
      target.sessionId,
      before,
      1,
    );
  });

  it("refuses to merge a session into itself", async () => {
    const { target } = await twoSessions();
    const before = await eventCounts("table_session.merged", target.sessionId);
    const response = await merge(target.sessionId, target.sessionId);
    expect(response.status).toBe(409);
    expect((await sessionRow(target.sessionId)).status).toBe("open");
    await expectEventsAdded(
      "table_session.merged",
      target.sessionId,
      before,
      0,
    );
  });

  it("refuses when either session already has a payment", async () => {
    const paidSource = await twoSessions();
    paidIdrBySession.set(paidSource.source.sessionId, 5000);
    const beforeSource = await eventCounts(
      "table_session.merged",
      paidSource.target.sessionId,
    );
    expect(
      (await merge(paidSource.target.sessionId, paidSource.source.sessionId))
        .status,
    ).toBe(409);
    expect((await sessionRow(paidSource.source.sessionId)).status).toBe("open");
    expect(
      (await orderRow(paidSource.sourceOrders[0]!.uuid)).table_session_id,
    ).toBe(paidSource.source.sessionId);
    await expectEventsAdded(
      "table_session.merged",
      paidSource.target.sessionId,
      beforeSource,
      0,
    );

    const paidTarget = await twoSessions();
    paidIdrBySession.set(paidTarget.target.sessionId, 5000);
    expect(
      (await merge(paidTarget.target.sessionId, paidTarget.source.sessionId))
        .status,
    ).toBe(409);
    expect((await sessionRow(paidTarget.source.sessionId)).status).toBe("open");
  });

  it("refuses sessions that are not running, or differ in payment mode or outlet", async () => {
    const { target, source } = await twoSessions();

    // Closed source.
    const closed = await openSession();
    await staff.client
      .post(`/api/table-sessions/${closed.sessionId}/close`)
      .set(originHeader)
      .send({ tableCleaned: true, waiterConfirmedEmpty: true });
    expect((await merge(target.sessionId, closed.sessionId)).status).toBe(409);

    // Pending confirmation source (open-bill zone) into an open-bill target.
    const openBillTarget = await openSession(openBillZoneId);
    const pendingTable = await newTable(openBillZoneId);
    const pending = await scan(app, { token: pendingTable.token });
    expect(pending.body.data.session.status).toBe("pending_confirmation");
    expect(
      (await merge(openBillTarget.sessionId, pending.body.data.session.id))
        .status,
    ).toBe(409);

    // Different payment mode.
    expect(
      (await merge(target.sessionId, openBillTarget.sessionId)).status,
    ).toBe(409);

    // Different outlet.
    const outletB = await outletBFixtures();
    expect((await merge(target.sessionId, outletB.sessionId)).status).toBe(409);

    // The valid pair was never touched.
    expect((await sessionRow(source.sessionId)).status).toBe("open");
    expect(await billOf(source.sessionId)).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. MOVE-ITEMS (pindah item)
// ===========================================================================

describe("move session items (legend-685n)", () => {
  async function twoSessionsWithOrder() {
    const from = await openSession();
    const to = await openSession();
    await seedOrder(to.sessionId, [{ quantity: 1, unit: 18000 }]);
    return { from, to };
  }

  it("re-points a whole order to the other session and keeps item ids", async () => {
    const { from, to } = await twoSessionsWithOrder();
    const wholeOrder = await seedOrder(
      from.sessionId,
      [
        { quantity: 2, unit: 15000 },
        { quantity: 1, unit: 22000 },
      ],
      { discount: 3000, service: 1500 },
    );
    const stays = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 50000 },
    ]);
    const fromBefore = await billOf(from.sessionId);
    const toBefore = await billOf(to.sessionId);
    const moving = await orderRow(wholeOrder.uuid);
    const fromOrdersBefore = (await ordersOf(from.sessionId)).length;
    const toOrdersBefore = (await ordersOf(to.sessionId)).length;
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    const response = await moveItems(
      from.sessionId,
      to.sessionId,
      wholeOrder.items.map((item) => item.id),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.fromSessionId).toBe(from.sessionId);
    expect(response.body.data.toSessionId).toBe(to.sessionId);
    expect(response.body.data.movedItemCount).toBe(2);
    expect(response.body.data.movedTotalIdr).toBe(moving.total);
    // The very same order moved: no split, no new order.
    expect((await orderRow(wholeOrder.uuid)).table_session_id).toBe(
      to.sessionId,
    );
    expect((await ordersOf(from.sessionId)).length).toBe(fromOrdersBefore - 1);
    expect((await ordersOf(to.sessionId)).length).toBe(toOrdersBefore + 1);
    for (const item of wholeOrder.items)
      expect(await sessionOfItem(item.uuid)).toBe(to.sessionId);
    expect(await sessionOfItem(stays.items[0]!.uuid)).toBe(from.sessionId);
    expect(await billOf(from.sessionId)).toBe(fromBefore - moving.total);
    expect(await billOf(to.sessionId)).toBe(toBefore + moving.total);
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      1,
    );
  });

  it("splits an order on a partial selection, sharing discount, service and tax by line share", async () => {
    const { from, to } = await twoSessionsWithOrder();
    // Lines 20.000 and 80.000: the moved line is exactly 20% of the subtotal.
    const original = await seedOrder(
      from.sessionId,
      [
        { quantity: 2, unit: 10000 },
        { quantity: 4, unit: 20000 },
      ],
      { discount: 10000, service: 5000, tax: 8000 },
    );
    const [small, big] = original.items;
    const originalTotal = (await orderRow(original.uuid)).total;
    expect(originalTotal).toBe(103000);
    const fromBefore = await billOf(from.sessionId);
    const toBefore = await billOf(to.sessionId);
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    const response = await moveItems(from.sessionId, to.sessionId, [small!.id]);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.movedItemCount).toBe(1);
    expect(response.body.data.movedTotalIdr).toBe(20600);
    // Item ids are kept; the moved item sits in a new order of the other session.
    expect(await itemExists(small!.uuid)).toBe(true);
    expect(await sessionOfItem(small!.uuid)).toBe(to.sessionId);
    expect(await sessionOfItem(big!.uuid)).toBe(from.sessionId);
    const kept = await orderRow(original.uuid);
    expect(kept.table_session_id).toBe(from.sessionId);
    const newOrder = (await ordersOf(to.sessionId)).find(
      (order) => order.id !== kept.id && order.subtotal === 20000,
    );
    expect(newOrder).toBeDefined();
    expect(newOrder).toMatchObject({
      subtotal: 20000,
      discount: 2000,
      service: 1000,
      tax: 1600,
      rounding: 0,
      total: 20600,
    });
    expect(kept).toMatchObject({
      subtotal: 80000,
      discount: 8000,
      service: 4000,
      tax: 6400,
      rounding: 0,
      total: 82400,
    });
    // Nothing is created or lost, and each order still satisfies its total check.
    expect(kept.total + newOrder!.total).toBe(originalTotal);
    for (const order of [kept, newOrder!])
      expect(order.total).toBe(
        order.subtotal -
          order.discount +
          order.service +
          order.tax +
          order.rounding,
      );
    expect(await billOf(from.sessionId)).toBe(fromBefore - 20600);
    expect(await billOf(to.sessionId)).toBe(toBefore + 20600);
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      1,
    );
  });

  it("repeating a move whose items already sit in the target answers 200 and records nothing twice", async () => {
    const { from, to } = await twoSessionsWithOrder();
    const order = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 12000 },
      { quantity: 1, unit: 13000 },
    ]);
    const body = [order.items[0]!.id];
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    const first = await moveItems(from.sessionId, to.sessionId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const toBill = await billOf(to.sessionId);
    const fromBill = await billOf(from.sessionId);
    const again = await moveItems(from.sessionId, to.sessionId, body);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await billOf(to.sessionId)).toBe(toBill);
    expect(await billOf(from.sessionId)).toBe(fromBill);
    expect((await ordersOf(to.sessionId)).length).toBe(2);
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      1,
    );
  });

  it("refuses voided items, items of another session and an unknown item", async () => {
    const { from, to } = await twoSessionsWithOrder();
    const order = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 9000 },
      { quantity: 1, unit: 7000, voided: true },
    ]);
    const stranger = await openSession();
    const foreign = await seedOrder(stranger.sessionId, [
      { quantity: 1, unit: 5000 },
    ]);
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    const voided = await moveItems(from.sessionId, to.sessionId, [
      order.items[1]!.id,
    ]);
    expect([404, 409]).toContain(voided.status);
    const notMine = await moveItems(from.sessionId, to.sessionId, [
      foreign.items[0]!.id,
    ]);
    expect([404, 409]).toContain(notMine.status);
    const unknown = await moveItems(from.sessionId, to.sessionId, [
      createUlid(),
    ]);
    expect([404, 409]).toContain(unknown.status);
    // One bad id spoils the whole request: the valid item stays put too.
    const mixed = await moveItems(from.sessionId, to.sessionId, [
      order.items[0]!.id,
      foreign.items[0]!.id,
    ]);
    expect([404, 409]).toContain(mixed.status);

    expect(await sessionOfItem(order.items[0]!.uuid)).toBe(from.sessionId);
    expect(await sessionOfItem(foreign.items[0]!.uuid)).toBe(
      stranger.sessionId,
    );
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      0,
    );
  });

  it("refuses sessions that are the same, not running, paid, or in another outlet", async () => {
    const { from, to } = await twoSessionsWithOrder();
    const order = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 11000 },
      { quantity: 1, unit: 12000 },
    ]);
    const ids = [order.items[0]!.id];
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    expect((await moveItems(from.sessionId, from.sessionId, ids)).status).toBe(
      409,
    );

    const closed = await openSession();
    await staff.client
      .post(`/api/table-sessions/${closed.sessionId}/close`)
      .set(originHeader)
      .send({ tableCleaned: true, waiterConfirmedEmpty: true });
    expect(
      (await moveItems(from.sessionId, closed.sessionId, ids)).status,
    ).toBe(409);

    const pendingTable = await newTable(openBillZoneId);
    const pending = await scan(app, { token: pendingTable.token });
    expect(
      (await moveItems(from.sessionId, pending.body.data.session.id, ids))
        .status,
    ).toBe(409);

    const outletB = await outletBFixtures();
    expect(
      (await moveItems(from.sessionId, outletB.sessionId, ids)).status,
    ).toBe(409);

    paidIdrBySession.set(to.sessionId, 4000);
    expect((await moveItems(from.sessionId, to.sessionId, ids)).status).toBe(
      409,
    );
    paidIdrBySession.clear();
    paidIdrBySession.set(from.sessionId, 4000);
    expect((await moveItems(from.sessionId, to.sessionId, ids)).status).toBe(
      409,
    );

    expect(await sessionOfItem(order.items[0]!.uuid)).toBe(from.sessionId);
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      0,
    );
  });

  it("refuses to split an order that already has a payment link", async () => {
    const { from, to } = await twoSessionsWithOrder();
    const order = await seedOrder(
      from.sessionId,
      [
        { quantity: 1, unit: 20000 },
        { quantity: 1, unit: 30000 },
      ],
      { paymentLink: true },
    );
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    const response = await moveItems(from.sessionId, to.sessionId, [
      order.items[0]!.id,
    ]);

    expect(response.status).toBe(409);
    expect(await sessionOfItem(order.items[0]!.uuid)).toBe(from.sessionId);
    expect((await orderRow(order.uuid)).total).toBe(50000);
    expect((await ordersOf(to.sessionId)).length).toBe(1);
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      0,
    );
  });

  it("rejects an empty item list", async () => {
    const { from, to } = await twoSessionsWithOrder();
    const response = await moveItems(from.sessionId, to.sessionId, []);
    expect([400, 422]).toContain(response.status);
  });
});

// ===========================================================================
// 4. Auth and tenant / outlet isolation
// ===========================================================================

describe("table operations access (legend-685n)", () => {
  const bodies = (sessionId: string) =>
    [
      ["move", { toTableId: randomUUID() }],
      ["merge", { sourceSessionId: randomUUID() }],
      [
        "move-items",
        { toSessionId: randomUUID(), orderItemIds: [createUlid()] },
      ],
    ].map(([route, body]) => ({
      url: `/api/table-sessions/${sessionId}/${route as string}`,
      body: body as Record<string, unknown>,
    }));

  it("answers 401 to a visitor who is not signed in", async () => {
    const { sessionId } = await openSession();
    for (const { url, body } of bodies(sessionId)) {
      const response = await agent(app).post(url).set(originHeader).send(body);
      expect(response.status).toBe(401);
    }
  });

  it("answers 403 when the request does not come from a trusted origin", async () => {
    const { sessionId } = await openSession();
    for (const { url, body } of bodies(sessionId)) {
      const response = await staff.client.post(url).send(body);
      expect(response.status).toBe(403);
    }
  });

  it("answers 403 to an account without the floor.table.operate permission", async () => {
    const { sessionId, tableId } = await openSession();
    const noRole = agent(app);
    await signUp(noRole, "No Operate Role");
    const before = await eventCounts("table_session.moved", sessionId);
    for (const { url, body } of bodies(sessionId)) {
      const response = await noRole.post(url).set(originHeader).send(body);
      expect(response.status).toBe(403);
    }
    const real = await noRole
      .post(`/api/table-sessions/${sessionId}/move`)
      .set(originHeader)
      .send({ toTableId: await emptyTable() });
    expect(real.status).toBe(403);
    expect((await sessionRow(sessionId)).table_id).toBe(tableId);
    await expectEventsAdded("table_session.moved", sessionId, before, 0);
  });

  it("hides another tenant's session behind a 404", async () => {
    isolated = await createIsolatedTenant(`ops-${randomUUID().slice(0, 6)}`);
    const tenantTwo = await staffOfIsolatedTenant(app, isolated);
    const { sessionId, tableId } = await openSession();
    const other = await openSession();
    const headers = { Host: isolated.hostname };
    const asTenantTwo = (route: string, body: Record<string, unknown>) =>
      tenantTwo.client
        .post(`/api/table-sessions/${sessionId}/${route}`)
        .set(headers)
        .set(originHeader)
        .send(body);

    expect(
      (await asTenantTwo("move", { toTableId: await emptyTable() })).status,
    ).toBe(404);
    expect(
      (await asTenantTwo("merge", { sourceSessionId: other.sessionId })).status,
    ).toBe(404);
    expect(
      (
        await asTenantTwo("move-items", {
          toSessionId: other.sessionId,
          orderItemIds: [createUlid()],
        })
      ).status,
    ).toBe(404);
    expect((await sessionRow(sessionId)).table_id).toBe(tableId);
  });

  it("refuses a supervisor of outlet A an outlet B session", async () => {
    const outletB = await outletBFixtures();
    const own = await openSession();
    const supervisor = await staffWithRole(app, {
      template: "supervisor",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Operations Outlet A Supervisor",
    });
    const before = await eventCounts("table_session.moved", outletB.sessionId);

    // Outlet row security hides the session (404) or the guard refuses (403);
    // either way the supervisor changes nothing in outlet B.
    const moved = await move(
      outletB.sessionId,
      outletB.freeTableId,
      supervisor.client,
    );
    expect([403, 404]).toContain(moved.status);
    const merged = await merge(
      outletB.sessionId,
      own.sessionId,
      supervisor.client,
    );
    expect([403, 404]).toContain(merged.status);
    const itemsMoved = await moveItems(
      outletB.sessionId,
      own.sessionId,
      [createUlid()],
      supervisor.client,
    );
    expect([403, 404]).toContain(itemsMoved.status);
    expect((await sessionRow(outletB.sessionId)).status).toBe("open");
    expect((await sessionRow(own.sessionId)).status).toBe("open");
    await expectEventsAdded(
      "table_session.moved",
      outletB.sessionId,
      before,
      0,
    );
  });
});

// ===========================================================================
// 5. Review fixes (legend-685n)
// ===========================================================================
//
// Assumptions where the brief is silent:
// - A POS tender is "money taken" when its status is `captured` (or
//   `authorized`); `voided` and `failed` tenders do not count.
// - A pos_orders row must carry the same channel as its order, so tender
//   orders are seeded with channel `pos`.
// - "Live orders" for the pricing-mode rule are the non-voided orders of a
//   session.
// - A reservation hold is "the session's own" when it is on the table the
//   session currently sits at.

describe("review fixes (legend-685n)", () => {
  const posOrderUuids: string[] = [];
  const reservationIds: string[] = [];

  afterAll(async () => {
    await owner.query(
      "DELETE FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [seededTenantId, posOrderUuids],
    );
    await owner.query(
      "DELETE FROM pos_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [seededTenantId, posOrderUuids],
    );
    await owner.query(
      "UPDATE table_sessions SET reservation_id = NULL WHERE tenant_id = $1 AND reservation_id = ANY($2::uuid[])",
      [seededTenantId, reservationIds],
    );
    await owner.query(
      "DELETE FROM reservation_tables WHERE tenant_id = $1 AND reservation_id = ANY($2::uuid[])",
      [seededTenantId, reservationIds],
    );
    await owner.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, reservationIds],
    );
    await owner.query(
      "DELETE FROM service_requests WHERE tenant_id = $1 AND table_id = ANY($2::uuid[])",
      [seededTenantId, tableIds],
    );
  });

  /** A POS-channel order in the session with one tender of the given status. */
  async function seedPosTender(
    sessionId: string,
    status: "captured" | "voided" | "failed",
  ) {
    const order = await seedOrder(sessionId, [{ quantity: 1, unit: 30000 }]);
    posOrderUuids.push(order.uuid);
    await owner.query("UPDATE orders SET channel = 'pos' WHERE id = $1", [
      order.uuid,
    ]);
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       SELECT id, tenant_id, outlet_id, channel FROM orders WHERE id = $1`,
      [order.uuid],
    );
    await owner.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
          amount_idr, status, requested_at, resolved_at)
       SELECT tenant_id, outlet_id, id, 'card', 'manual', 30000, $2, now(), now()
       FROM orders WHERE id = $1`,
      [order.uuid, status],
    );
    return order;
  }

  async function setPricesIncludeTax(orderUuid: string, value: boolean) {
    await owner.query(
      "UPDATE orders SET prices_include_tax = $2 WHERE id = $1",
      [orderUuid, value],
    );
  }

  /** Seat a reservation on the session, holding the given tables. */
  async function seatReservation(sessionId: string, holdTableIds: string[]) {
    const reservationId = randomUUID();
    reservationIds.push(reservationId);
    await owner.query(
      `INSERT INTO reservations
         (id, tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax,
          deposit_idr, policy_snapshot, status, source, seated_at, table_session_id)
       SELECT $1, tenant_id, outlet_id, 'Tamu Operasi', now(), 90, 2, 0, '{}',
          'seated', 'staff', now(), id
       FROM table_sessions WHERE id = $2`,
      [reservationId, sessionId],
    );
    for (const holdTableId of holdTableIds)
      await owner.query(
        `INSERT INTO reservation_tables
           (tenant_id, outlet_id, reservation_id, table_id, starts_at, ends_at)
         SELECT tenant_id, outlet_id, $1, $2, now() - interval '30 minutes',
           now() + interval '60 minutes'
         FROM table_sessions WHERE id = $3`,
        [reservationId, holdTableId, sessionId],
      );
    await owner.query(
      "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
      [sessionId, reservationId],
    );
    return reservationId;
  }

  async function holdReleased(reservationId: string, tableId: string) {
    const { rows } = await owner.query<{ released_at: Date | null }>(
      "SELECT released_at FROM reservation_tables WHERE reservation_id = $1 AND table_id = $2",
      [reservationId, tableId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.released_at !== null;
  }

  // ---- 1. POS tender counts as paid ---------------------------------------

  it("refuses to merge a session that has a captured POS tender, as source or as target", async () => {
    const paidSource = await twoPlainSessions();
    await seedPosTender(paidSource.source.sessionId, "captured");
    expect(
      (await merge(paidSource.target.sessionId, paidSource.source.sessionId))
        .status,
    ).toBe(409);
    expect((await sessionRow(paidSource.source.sessionId)).status).toBe("open");

    const paidTarget = await twoPlainSessions();
    await seedPosTender(paidTarget.target.sessionId, "captured");
    expect(
      (await merge(paidTarget.target.sessionId, paidTarget.source.sessionId))
        .status,
    ).toBe(409);
    expect((await sessionRow(paidTarget.source.sessionId)).status).toBe("open");
  });

  it("refuses to move items from or into a session that has a captured POS tender", async () => {
    const intoPaid = await twoPlainSessions();
    await seedPosTender(intoPaid.target.sessionId, "captured");
    const moving = await seedOrder(intoPaid.source.sessionId, [
      { quantity: 1, unit: 12000 },
    ]);
    expect(
      (
        await moveItems(
          intoPaid.source.sessionId,
          intoPaid.target.sessionId,
          moving.items.map((item) => item.id),
        )
      ).status,
    ).toBe(409);
    expect(await sessionOfItem(moving.items[0]!.uuid)).toBe(
      intoPaid.source.sessionId,
    );

    const fromPaid = await twoPlainSessions();
    await seedPosTender(fromPaid.source.sessionId, "captured");
    const leaving = await seedOrder(fromPaid.source.sessionId, [
      { quantity: 1, unit: 12000 },
    ]);
    expect(
      (
        await moveItems(
          fromPaid.source.sessionId,
          fromPaid.target.sessionId,
          leaving.items.map((item) => item.id),
        )
      ).status,
    ).toBe(409);
    expect(await sessionOfItem(leaving.items[0]!.uuid)).toBe(
      fromPaid.source.sessionId,
    );
  });

  it("does not treat a voided or failed POS tender as paid", async () => {
    for (const status of ["voided", "failed"] as const) {
      const pair = await twoPlainSessions();
      await seedPosTender(pair.source.sessionId, status);
      const merged = await merge(pair.target.sessionId, pair.source.sessionId);
      expect(merged.status, `${status}: ${JSON.stringify(merged.body)}`).toBe(
        200,
      );
    }
    const pair = await twoPlainSessions();
    await seedPosTender(pair.target.sessionId, "voided");
    const moving = await seedOrder(pair.source.sessionId, [
      { quantity: 1, unit: 12000 },
    ]);
    const moved = await moveItems(
      pair.source.sessionId,
      pair.target.sessionId,
      moving.items.map((item) => item.id),
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  });

  // ---- 2. Pay-first, fully paid session can move --------------------------

  it("moves a fully paid pay-first session to a free pay-first table", async () => {
    const { sessionId } = await openSession(payFirstZoneId);
    await seedOrder(sessionId, [{ quantity: 2, unit: 20000 }]);
    paidIdrBySession.set(sessionId, await billOf(sessionId));
    expect(paidIdrBySession.get(sessionId)).toBeGreaterThan(0);
    const toTableId = await emptyTable(payFirstZoneId);

    const response = await move(sessionId, toTableId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await sessionRow(sessionId)).table_id).toBe(toTableId);
    expect(await tableStatus(toTableId)).toBe("occupied");
  });

  it("still refuses to move a fully paid open-bill session", async () => {
    const { sessionId, tableId } = await openSession(openBillZoneId);
    await seedOrder(sessionId, [{ quantity: 2, unit: 20000 }]);
    paidIdrBySession.set(sessionId, await billOf(sessionId));
    const toTableId = await emptyTable(openBillZoneId);

    expect((await move(sessionId, toTableId)).status).toBe(409);
    expect((await sessionRow(sessionId)).table_id).toBe(tableId);
  });

  // ---- 3. Mixed pricing ---------------------------------------------------

  it("refuses to merge sessions whose live orders differ in prices-include-tax, and merges the same mode", async () => {
    const mixed = await twoPlainSessions();
    const mixedSourceOrder = await seedOrder(mixed.source.sessionId, [
      { quantity: 1, unit: 10000 },
    ]);
    await setPricesIncludeTax(mixedSourceOrder.uuid, true);
    expect(
      (await merge(mixed.target.sessionId, mixed.source.sessionId)).status,
    ).toBe(409);
    expect((await sessionRow(mixed.source.sessionId)).status).toBe("open");
    expect((await orderRow(mixedSourceOrder.uuid)).table_session_id).toBe(
      mixed.source.sessionId,
    );

    const same = await twoPlainSessions();
    for (const order of [
      ...(await ordersOf(same.target.sessionId)),
      ...(await ordersOf(same.source.sessionId)),
    ])
      await setPricesIncludeTax(order.id, true);
    const merged = await merge(same.target.sessionId, same.source.sessionId);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  });

  it("refuses to move items into a session with a different prices-include-tax mode, and moves the same mode", async () => {
    const mixed = await twoPlainSessions();
    const moving = await seedOrder(mixed.source.sessionId, [
      { quantity: 1, unit: 10000 },
    ]);
    await setPricesIncludeTax(moving.uuid, true);
    expect(
      (
        await moveItems(
          mixed.source.sessionId,
          mixed.target.sessionId,
          moving.items.map((item) => item.id),
        )
      ).status,
    ).toBe(409);
    expect(await sessionOfItem(moving.items[0]!.uuid)).toBe(
      mixed.source.sessionId,
    );

    const same = await twoPlainSessions();
    const sameMoving = await seedOrder(same.source.sessionId, [
      { quantity: 1, unit: 10000 },
    ]);
    for (const order of [
      ...(await ordersOf(same.target.sessionId)),
      ...(await ordersOf(same.source.sessionId)),
    ])
      await setPricesIncludeTax(order.id, true);
    const moved = await moveItems(
      same.source.sessionId,
      same.target.sessionId,
      sameMoving.items.map((item) => item.id),
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await sessionOfItem(sameMoving.items[0]!.uuid)).toBe(
      same.target.sessionId,
    );
  });

  // ---- 4. Move-items across payment modes ---------------------------------

  it("refuses to move items between sessions with a different payment mode", async () => {
    const from = await openSession(payFirstZoneId);
    const to = await openSession(openBillZoneId);
    await seedOrder(to.sessionId, [{ quantity: 1, unit: 18000 }]);
    const order = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 12000 },
    ]);

    const response = await moveItems(
      from.sessionId,
      to.sessionId,
      order.items.map((item) => item.id),
    );

    expect(response.status).toBe(409);
    expect(await sessionOfItem(order.items[0]!.uuid)).toBe(from.sessionId);
  });

  // ---- 5. Reservation hold on move ----------------------------------------

  it("releases the reservation hold of the table it leaves, so the session can move again", async () => {
    const { sessionId, tableId } = await openSession();
    await seedOrder(sessionId, [{ quantity: 1, unit: 25000 }]);
    const reservationId = await seatReservation(sessionId, [tableId]);
    const secondTable = await emptyTable();
    const thirdTable = await emptyTable();

    const first = await move(sessionId, secondTable);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await holdReleased(reservationId, tableId)).toBe(true);

    const second = await move(sessionId, thirdTable);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect((await sessionRow(sessionId)).table_id).toBe(thirdTable);
  });

  it("refuses to move a session whose reservation holds a second table", async () => {
    const { sessionId, tableId } = await openSession();
    await seedOrder(sessionId, [{ quantity: 1, unit: 25000 }]);
    const extraTable = await emptyTable();
    const reservationId = await seatReservation(sessionId, [
      tableId,
      extraTable,
    ]);
    const toTableId = await emptyTable();

    expect((await move(sessionId, toTableId)).status).toBe(409);
    expect((await sessionRow(sessionId)).table_id).toBe(tableId);
    expect(await holdReleased(reservationId, tableId)).toBe(false);
    expect(await holdReleased(reservationId, extraTable)).toBe(false);
  });

  // ---- 6. Merge with reservation ------------------------------------------

  it("refuses to merge a source whose reservation holds tables other than its own", async () => {
    const { target, source } = await twoPlainSessions();
    const extraTable = await emptyTable();
    const reservationId = await seatReservation(source.sessionId, [
      source.tableId,
      extraTable,
    ]);

    expect((await merge(target.sessionId, source.sessionId)).status).toBe(409);
    expect((await sessionRow(source.sessionId)).status).toBe("open");
    expect(await holdReleased(reservationId, source.tableId)).toBe(false);
  });

  it("merges a source with only its own reservation hold and releases that hold", async () => {
    const { target, source } = await twoPlainSessions();
    const reservationId = await seatReservation(source.sessionId, [
      source.tableId,
    ]);

    const response = await merge(target.sessionId, source.sessionId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await holdReleased(reservationId, source.tableId)).toBe(true);
  });

  // ---- 7. Open service request follows the session ------------------------

  it("re-points an open service request to the new table when the session moves", async () => {
    const { sessionId, tableId } = await openSession();
    await seedOrder(sessionId, [{ quantity: 1, unit: 25000 }]);
    const requestId = randomUUID();
    await owner.query(
      `INSERT INTO service_requests
         (id, tenant_id, outlet_id, table_session_id, table_id, zone_id, type, status,
          idempotency_key, request_fingerprint)
       SELECT $1, tenant_id, outlet_id, id, table_id, $2, 'call_waiter', 'pending', $3, $4
       FROM table_sessions WHERE id = $5`,
      [
        requestId,
        payFirstZoneId,
        `key-${requestId}`,
        "f".repeat(64),
        sessionId,
      ],
    );
    const toTableId = await emptyTable();

    const response = await move(sessionId, toTableId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { rows } = await owner.query<{ table_id: string; status: string }>(
      "SELECT table_id, status FROM service_requests WHERE id = $1",
      [requestId],
    );
    expect(rows[0]).toMatchObject({ table_id: toTableId, status: "pending" });
    expect(tableId).not.toBe(toTableId);
  });

  // ---- 8. Split only for QR orders ----------------------------------------

  it("refuses to split an order whose channel is not qr", async () => {
    const { from, to } = {
      from: await openSession(),
      to: await openSession(),
    };
    await seedOrder(to.sessionId, [{ quantity: 1, unit: 18000 }]);
    const order = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 20000 },
      { quantity: 1, unit: 30000 },
    ]);
    await owner.query("UPDATE orders SET channel = 'pos' WHERE id = $1", [
      order.uuid,
    ]);
    // pos_orders is not needed for this check; only the channel matters.

    const response = await moveItems(from.sessionId, to.sessionId, [
      order.items[0]!.id,
    ]);

    expect(response.status).toBe(409);
    expect(await sessionOfItem(order.items[0]!.uuid)).toBe(from.sessionId);
    expect((await orderRow(order.uuid)).total).toBe(50000);
  });

  // legend-ekxy2: the move reads its requested items before it locks their
  // orders. A POS void that commits between that read and the lock must still
  // stop the move (a voided item may never travel to another bill).
  it("refuses an item voided while the move waits for the order lock", async () => {
    const from = await openSession();
    const to = await openSession();
    await seedOrder(to.sessionId, [{ quantity: 1, unit: 18000 }]);
    const order = await seedOrder(from.sessionId, [
      { quantity: 1, unit: 20000 },
      { quantity: 1, unit: 30000 },
    ]);
    const target = order.items[0]!;
    const before = await eventCounts(
      "table_session.items_moved",
      from.sessionId,
    );

    // A second connection holds the order row lock, as a POS void would.
    const blocker = await owner.connect();
    let response: Awaited<ReturnType<typeof moveItems>>;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        order.uuid,
      ]);
      // `.then` starts the request now; it is not awaited yet.
      // Both lines of the order are requested (whole-order move), so the
      // refusal is the voided-item rule and not the split rule.
      const pending = moveItems(
        from.sessionId,
        to.sessionId,
        order.items.map((item) => item.id),
      ).then((res) => res);
      // Wait until some other backend is blocked on a lock (the move), polling
      // instead of a blind sleep; capped so a changed lock order cannot hang.
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rows } = await blocker.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'`,
        );
        if (rows[0]!.waiting > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Let the waiting move finish any read it does just before the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await blocker.query(
        "UPDATE order_items SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, target.uuid],
      );
      await blocker.query("COMMIT");
      response = await pending;
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(JSON.stringify(response.body)).toContain("dibatalkan");
    expect(await sessionOfItem(target.uuid)).toBe(from.sessionId);
    expect((await orderRow(order.uuid)).table_session_id).toBe(from.sessionId);
    await expectEventsAdded(
      "table_session.items_moved",
      from.sessionId,
      before,
      0,
    );
  });

  /** Two running pay-first sessions, each with one live order. */
  async function twoPlainSessions() {
    const target = await openSession();
    const source = await openSession();
    await seedOrder(target.sessionId, [{ quantity: 1, unit: 20000 }]);
    await seedOrder(source.sessionId, [{ quantity: 1, unit: 15000 }]);
    return { target, source };
  }
});

// ===========================================================================
// EDC-01 (legend-ig2sl): move-items is a total-changing action. While an ECR
// (EDC) request on the order's bill is not final (pending / unknown), moving or
// splitting its items is refused 409 EDC_REQUEST_OPEN, so the amount the EDC
// charges always equals the POS bill. Once the request is final (declined /
// cancelled / failed) the lock lifts.
//
// Assumptions (spec: docs/PRD.md EDC-01; brief):
// - An ECR request is an `edc_transactions` row (mode 'ecr', type 'sale') whose
//   `reference` is the order number and `amount_idr` the bill total, as in
//   pos-edc-tender.test.ts.
// - The refusal carries the code EDC_REQUEST_OPEN somewhere in the error body.
// - Moving items out of the locked order is refused for a whole-order move and
//   for a partial split alike.
// ===========================================================================

describe("move session items while an ECR request is open (EDC-01)", () => {
  const edcTransactionIds: string[] = [];
  const terminalIds: string[] = [];

  afterAll(async () => {
    await owner.query(
      "DELETE FROM edc_transactions WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, edcTransactionIds],
    );
    await owner.query(
      "DELETE FROM payment_edc_terminals WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, terminalIds],
    );
  });

  /** Two running sessions; the target already has an order (so it is live). */
  async function twoSessions() {
    const from = await openSession();
    const to = await openSession();
    await seedOrder(to.sessionId, [{ quantity: 1, unit: 18000 }]);
    return { from, to };
  }

  /** A two-line order, so a partial selection is a real split. */
  function twoLineOrder(sessionId: string) {
    return seedOrder(sessionId, [
      { quantity: 1, unit: 25000 },
      { quantity: 1, unit: 30000 },
    ]);
  }

  /** The ECR request for the order's current bill, in the given status. */
  async function ecrRequest(orderUuid: string, status: string) {
    const { rows } = await owner.query<{
      outlet_id: string;
      number: string;
      total: number;
    }>(
      "SELECT outlet_id, number, total_idr::int AS total FROM orders WHERE id = $1",
      [orderUuid],
    );
    const order = rows[0]!;
    const terminalId = randomUUID();
    terminalIds.push(terminalId);
    await owner.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, $5, 'Test EDC', 'lan', '10.0.0.9',
               ARRAY['card','qris'], 'active')`,
      [
        terminalId,
        seededTenantId,
        order.outlet_id,
        `TID-${terminalId.slice(0, 8)}`,
        `MID-${terminalId.slice(0, 8)}`,
      ],
    );
    const id = randomUUID();
    edcTransactionIds.push(id);
    const final = ["approved", "declined", "cancelled", "failed"].includes(
      status,
    );
    await owner.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at, dispatched_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               'APP123', $10, $11, now())`,
      [
        id,
        seededTenantId,
        order.outlet_id,
        terminalId,
        order.number,
        randomUUID(),
        order.total,
        status,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
        final ? new Date() : null,
      ],
    );
    return id;
  }

  async function finalise(edcTransactionId: string, status: string) {
    await owner.query(
      "UPDATE edc_transactions SET status = $2, completed_at = now() WHERE id = $1",
      [edcTransactionId, status],
    );
  }

  function expectEdcRefusal(response: Awaited<ReturnType<typeof moveItems>>) {
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(JSON.stringify(response.body)).toContain("EDC_REQUEST_OPEN");
  }

  it("control: without an ECR request a whole-order move and a split are accepted", async () => {
    const { from, to } = await twoSessions();
    const whole = await twoLineOrder(from.sessionId);
    const whole2 = await twoLineOrder(from.sessionId);

    const wholeMove = await moveItems(
      from.sessionId,
      to.sessionId,
      whole.items.map((item) => item.id),
    );
    expect(wholeMove.status, JSON.stringify(wholeMove.body)).toBe(200);
    expect(await sessionOfItem(whole.items[0]!.uuid)).toBe(to.sessionId);

    const split = await moveItems(from.sessionId, to.sessionId, [
      whole2.items[0]!.id,
    ]);
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(await sessionOfItem(whole2.items[0]!.uuid)).toBe(to.sessionId);
    expect(await sessionOfItem(whole2.items[1]!.uuid)).toBe(from.sessionId);
  });

  it.each(["pending", "unknown"])(
    "refuses a whole-order move with 409 EDC_REQUEST_OPEN while the ECR request is %s",
    async (status) => {
      const { from, to } = await twoSessions();
      const order = await twoLineOrder(from.sessionId);
      await ecrRequest(order.uuid, status);
      const totalBefore = (await orderRow(order.uuid)).total;
      const fromBill = await billOf(from.sessionId);
      const toBill = await billOf(to.sessionId);
      const fromOrders = (await ordersOf(from.sessionId)).length;
      const toOrders = (await ordersOf(to.sessionId)).length;
      const before = await eventCounts(
        "table_session.items_moved",
        from.sessionId,
      );

      const response = await moveItems(
        from.sessionId,
        to.sessionId,
        order.items.map((item) => item.id),
      );

      expectEdcRefusal(response);
      const after = await orderRow(order.uuid);
      expect(after.table_session_id).toBe(from.sessionId);
      expect(after.total).toBe(totalBefore);
      for (const item of order.items)
        expect(await sessionOfItem(item.uuid)).toBe(from.sessionId);
      expect(await billOf(from.sessionId)).toBe(fromBill);
      expect(await billOf(to.sessionId)).toBe(toBill);
      expect((await ordersOf(from.sessionId)).length).toBe(fromOrders);
      expect((await ordersOf(to.sessionId)).length).toBe(toOrders);
      await expectEventsAdded(
        "table_session.items_moved",
        from.sessionId,
        before,
        0,
      );
    },
  );

  it.each(["pending", "unknown"])(
    "refuses a split of the order with 409 EDC_REQUEST_OPEN while the ECR request is %s: total unchanged, no new order",
    async (status) => {
      const { from, to } = await twoSessions();
      const order = await twoLineOrder(from.sessionId);
      await ecrRequest(order.uuid, status);
      const totalBefore = (await orderRow(order.uuid)).total;
      const fromOrders = (await ordersOf(from.sessionId)).length;
      const toOrders = (await ordersOf(to.sessionId)).length;
      const toBill = await billOf(to.sessionId);
      const before = await eventCounts(
        "table_session.items_moved",
        from.sessionId,
      );

      const response = await moveItems(from.sessionId, to.sessionId, [
        order.items[0]!.id,
      ]);

      expectEdcRefusal(response);
      // A second try is refused the same way: nothing was half applied.
      expectEdcRefusal(
        await moveItems(from.sessionId, to.sessionId, [order.items[0]!.id]),
      );
      const after = await orderRow(order.uuid);
      expect(after.table_session_id).toBe(from.sessionId);
      expect(after.total).toBe(totalBefore);
      expect(after.subtotal).toBe(55000);
      expect(await sessionOfItem(order.items[0]!.uuid)).toBe(from.sessionId);
      expect(await sessionOfItem(order.items[1]!.uuid)).toBe(from.sessionId);
      expect((await ordersOf(from.sessionId)).length).toBe(fromOrders);
      expect((await ordersOf(to.sessionId)).length).toBe(toOrders);
      expect(await billOf(to.sessionId)).toBe(toBill);
      await expectEventsAdded(
        "table_session.items_moved",
        from.sessionId,
        before,
        0,
      );
    },
  );

  it.each(["declined", "cancelled", "failed"])(
    "accepts the move again once the ECR request is final (%s)",
    async (finalStatus) => {
      const { from, to } = await twoSessions();
      const order = await twoLineOrder(from.sessionId);
      const request = await ecrRequest(order.uuid, "pending");

      expectEdcRefusal(
        await moveItems(from.sessionId, to.sessionId, [order.items[0]!.id]),
      );

      // The inquiry answers with a final status: the lock opens.
      await finalise(request, finalStatus);
      const split = await moveItems(from.sessionId, to.sessionId, [
        order.items[0]!.id,
      ]);
      expect(split.status, JSON.stringify(split.body)).toBe(200);
      expect(await sessionOfItem(order.items[0]!.uuid)).toBe(to.sessionId);
      expect(await sessionOfItem(order.items[1]!.uuid)).toBe(from.sessionId);
    },
  );

  it("accepts a move whose request is already final when it is made", async () => {
    const { from, to } = await twoSessions();
    const order = await twoLineOrder(from.sessionId);
    await ecrRequest(order.uuid, "declined");

    const response = await moveItems(
      from.sessionId,
      to.sessionId,
      order.items.map((item) => item.id),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await orderRow(order.uuid)).table_session_id).toBe(to.sessionId);
  });
});
