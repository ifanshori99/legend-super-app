// WS-03 link meja (legend-1nmh): staff group 2+ tables that each have an active
// session so they are served together. Contract: POST /api/table-links,
// POST /api/table-links/:groupId/unlink, `linkGroup` on the floor board rows,
// events `table_session.linked`, `table_session.unlinked`, `table.status_changed`.
//
// Real Express app + Better Auth + RBAC + PostgreSQL (disposable server from
// `pnpm test`). Orders are seeded straight into SQL (superuser pool).
//
// Assumptions where the brief is silent:
// - A group member = (table, its active session); active = pending_confirmation,
//   open or bill_requested. Bills and sessions are never touched by link/unlink.
// - Refusals (no active session, closed/voided session, table already in
//   another group, other outlet, single table without groupId, duplicate ids)
//   answer 400, 409 or 422 (not 404); the tests only require that no link rows are written.
// - Event and audit rows are matched by event name plus the id of the session
//   (or table) appearing anywhere in the stored event JSON, so the tests do not
//   depend on which payload field carries it. The single audit row of a link
//   request is found by the group id appearing in the audit event JSON.
// - Dissolving every member with no `tableIds` (unlink all) records each
//   member's reason as `staff` or `group_dissolved` (brief names no reason).
// - `unlinkedTableIds` of an unlink that dissolves the group contains at least
//   the table(s) the caller named (or all members when none were named).
// - Closing a session with a zero bill and `tableCleaned: true` frees its table
//   to `available` (close rules of legend-685n / ORD-10).
// - Board rows are `data.tables[]`; the group sits on the row (sibling of
//   `table`), per tableLiveStatusSchema; no group means null or absent.
// - Another tenant sees a 404; an outlet-A supervisor gets 403 or 404 on
//   outlet B tables.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  return { tableId: table.id as string, token: qr.token as string };
}

/** A table nobody sits at: status `available`, no session. */
async function emptyTable(zoneId = payFirstZoneId) {
  return (await newTable(zoneId)).tableId;
}

type Seat = { sessionId: string; tableId: string };

/** Scan a fresh table and confirm it so the session is `open`. */
async function openSession(zoneId = payFirstZoneId): Promise<Seat> {
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

/** Open-bill scan left unconfirmed: status `pending_confirmation`. */
async function pendingSession(): Promise<Seat> {
  const { tableId, token } = await newTable(openBillZoneId);
  const scanned = await scan(app, { token });
  expect(scanned.status).toBe(201);
  expect(scanned.body.data.session.status).toBe("pending_confirmation");
  return { sessionId: scanned.body.data.session.id as string, tableId };
}

async function openSessions(count: number): Promise<Seat[]> {
  const seats: Seat[] = [];
  for (let index = 0; index < count; index++) seats.push(await openSession());
  return seats;
}

/** Insert one order with one line straight into the database. */
async function seedOrder(sessionId: string, unit: number, quantity = 1) {
  const { rows } = await owner.query<{
    outlet_id: string;
    payment_mode: string;
  }>("SELECT outlet_id, payment_mode FROM table_sessions WHERE id = $1", [
    sessionId,
  ]);
  const session = rows[0];
  if (!session) throw new Error(`No session ${sessionId}`);
  const uuid = ulidToUuid(createUlid());
  const itemUuid = ulidToUuid(createUlid());
  const total = unit * quantity;
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
      `LNK-${randomUUID().slice(0, 12)}`,
      sessionId,
      session.payment_mode,
      total,
      today,
    ],
  );
  await owner.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
        quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
        fire_status, status, reserved_business_date)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Item 1', $6, $7, 0, $8, '[]'::jsonb, 'fired', 'queued', $9)`,
    [
      itemUuid,
      seededTenantId,
      session.outlet_id,
      uuid,
      menuItemId,
      quantity,
      unit,
      total,
      today,
    ],
  );
  return uuid;
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

async function orderSnapshot(sessionId: string) {
  const { rows } = await owner.query(
    `SELECT id, table_session_id, subtotal_idr::int AS subtotal, total_idr::int AS total, status
     FROM orders WHERE tenant_id = $1 AND table_session_id = $2 ORDER BY id`,
    [seededTenantId, sessionId],
  );
  return rows;
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

/** Outbox events with this name whose JSON mentions `key`, as compact JSON. */
async function eventsOf(name: string, key: string): Promise<string[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3::text || '%'`,
    [seededTenantId, name, key],
  );
  return rows.map((row) => JSON.stringify(row.event));
}

async function eventCount(name: string, key: string): Promise<number> {
  return (await eventsOf(name, key)).length;
}

async function auditRowsMentioning(key: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_logs
     WHERE tenant_id = $1 AND event::text LIKE '%' || $2::text || '%'`,
    [seededTenantId, key],
  );
  return rows[0]!.count;
}

/** Link rows ever written for these tables (live or left) plus all groups. */
async function linkRowCounts(forTableIds: string[]) {
  const { rows: members } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM table_link_members WHERE tenant_id = $1 AND table_id = ANY($2::uuid[])",
    [seededTenantId, forTableIds],
  );
  const { rows: groups } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM table_link_groups WHERE tenant_id = $1",
    [seededTenantId],
  );
  return { members: members[0]!.count, groups: groups[0]!.count };
}

type BoardRow = {
  table: { id: string };
  session: { id: string; status: string } | null;
  linkGroup?: { id: string; tableIds: string[] } | null;
};

async function boardRow(tableId: string, outletId = seededOutletA) {
  const board = await staff.client.get(`/api/outlets/${outletId}/floor`);
  expect(board.status).toBe(200);
  const row = (board.body.data.tables as BoardRow[]).find(
    (candidate) => candidate.table.id === tableId,
  );
  expect(row, `table ${tableId} on the floor board`).toBeDefined();
  return row!;
}

async function expectGroupOnBoard(
  members: string[],
  groupId: string,
  outletId = seededOutletA,
) {
  for (const tableId of members) {
    const row = await boardRow(tableId, outletId);
    expect(row.linkGroup?.id).toBe(groupId);
    expect([...(row.linkGroup?.tableIds ?? [])].sort()).toEqual(
      [...members].sort(),
    );
  }
}

async function expectNoGroupOnBoard(tableId: string) {
  const row = await boardRow(tableId);
  expect(row.linkGroup ?? null).toBeNull();
}

// ---- requests -------------------------------------------------------------

const linkReq = (
  members: string[],
  extra: Record<string, unknown> = {},
  client = staff.client,
) =>
  client
    .post("/api/table-links")
    .set(originHeader)
    .send({ tableIds: members, ...extra });
const unlinkReq = (
  groupId: string,
  body: Record<string, unknown> = {},
  client = staff.client,
) =>
  client
    .post(`/api/table-links/${groupId}/unlink`)
    .set(originHeader)
    .send(body);
const closeReq = (sessionId: string, client = staff.client) =>
  client
    .post(`/api/table-sessions/${sessionId}/close`)
    .set(originHeader)
    .send({ tableCleaned: true });
const moveReq = (sessionId: string, toTableId: string) =>
  staff.client
    .post(`/api/table-sessions/${sessionId}/move`)
    .set(originHeader)
    .send({ toTableId });
const mergeReq = (targetId: string, sourceSessionId: string) =>
  staff.client
    .post(`/api/table-sessions/${targetId}/merge`)
    .set(originHeader)
    .send({ sourceSessionId });

/** Link the seats' tables and return the group id (asserts success). */
async function linkSeats(seats: Seat[]): Promise<string> {
  const response = await linkReq(seats.map((seat) => seat.tableId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.group.id as string;
}

async function unlinkedReasons(sessionId: string): Promise<string[]> {
  return (await eventsOf("table_session.unlinked", sessionId)).map((event) => {
    const match = /"reason":"([a-z_]+)"/.exec(event);
    return match ? match[1]! : "";
  });
}

/** Sessions (and a free table) in outlet B, outside outlet A's scope. */
async function outletBFixtures(seatCount = 2) {
  const zone = await createFloorZone(
    tenantContext(),
    seededOutletB,
    {
      name: `Link B ${randomUUID().slice(0, 6)}`,
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
  const seats: Seat[] = [];
  for (let index = 0; index < seatCount; index++) {
    const tableId = await makeTable();
    const qr = await issueTableQr(tenantContext(), tableId, staff.userId);
    const scanned = await scan(app, { token: qr.token });
    expect(scanned.status).toBe(201);
    seats.push({ sessionId: scanned.body.data.session.id as string, tableId });
  }
  return seats;
}

// ---- lifecycle ------------------------------------------------------------

beforeAll(async () => {
  app = createApp();
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Table Link Owner",
  });
  const hours = [
    { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
  ];
  const payFirst = await createZone(staff.client, { hours });
  const openBill = await createZone(staff.client, {
    paymentMode: "open_bill",
    hours,
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
     VALUES ($1, $2, $3, 'Link Meja Uji', 0)`,
    [categoryId, seededTenantId, brandId],
  );
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Link', true, $5)`,
    [menuItemId, seededTenantId, brandId, categoryId, randomUUID()],
  );
});

afterAll(async () => {
  try {
    setTableSessionSettlementLookup(null);
    const registered = await owner.query<{ name: string | null }>(
      "SELECT to_regclass('table_link_members')::text AS name",
    );
    if (registered.rows[0]?.name) {
      await owner.query(
        "DELETE FROM table_link_members WHERE tenant_id = $1 AND table_id = ANY($2::uuid[])",
        [seededTenantId, tableIds],
      );
      await owner.query(
        `DELETE FROM table_link_groups WHERE tenant_id = $1
           AND id NOT IN (SELECT group_id FROM table_link_members WHERE tenant_id = $1)`,
        [seededTenantId],
      );
    }
    await owner.query(
      `DELETE FROM order_items WHERE tenant_id = $1 AND order_id IN
        (SELECT id FROM orders WHERE tenant_id = $1 AND table_session_id IN
          (SELECT id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2::uuid[])))`,
      [seededTenantId, tableIds],
    );
    await owner.query(
      `DELETE FROM orders WHERE tenant_id = $1 AND table_session_id IN
        (SELECT id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2::uuid[]))`,
      [seededTenantId, tableIds],
    );
    await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
    await owner.query("DELETE FROM menu_items WHERE id = $1", [menuItemId]);
    await owner.query("DELETE FROM menu_categories WHERE id = $1", [
      categoryId,
    ]);
    if (isolated) await dropIsolatedTenant(isolated);
  } finally {
    await owner.end();
  }
});

// ===========================================================================
// 1. LINK
// ===========================================================================

describe("link tables (legend-1nmh)", () => {
  it("groups two tables with active sessions and touches neither bill nor session", async () => {
    const [a, b] = await openSessions(2);
    await seedOrder(a!.sessionId, 25000, 2);
    await seedOrder(b!.sessionId, 18000);
    const billsBefore = [
      await billOf(a!.sessionId),
      await billOf(b!.sessionId),
    ];
    const ordersBefore = [
      await orderSnapshot(a!.sessionId),
      await orderSnapshot(b!.sessionId),
    ];
    const statusBefore = [
      (await sessionRow(a!.sessionId)).status,
      (await sessionRow(b!.sessionId)).status,
    ];

    const response = await linkReq([a!.tableId, b!.tableId]);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const group = response.body.data.group;
    expect(group.id).toEqual(expect.any(String));
    expect(group.outletId).toBe(seededOutletA);
    expect(
      group.members.map((member: { tableId: string }) => member.tableId).sort(),
    ).toEqual([a!.tableId, b!.tableId].sort());
    const sessionOf = new Map<string, string>(
      group.members.map((member: { tableId: string; sessionId: string }) => [
        member.tableId,
        member.sessionId,
      ]),
    );
    expect(sessionOf.get(a!.tableId)).toBe(a!.sessionId);
    expect(sessionOf.get(b!.tableId)).toBe(b!.sessionId);

    await expectGroupOnBoard([a!.tableId, b!.tableId], group.id);
    // Service only: bills stay separate, sessions unchanged.
    expect([await billOf(a!.sessionId), await billOf(b!.sessionId)]).toEqual(
      billsBefore,
    );
    expect([
      await orderSnapshot(a!.sessionId),
      await orderSnapshot(b!.sessionId),
    ]).toEqual(ordersBefore);
    expect([
      (await sessionRow(a!.sessionId)).status,
      (await sessionRow(b!.sessionId)).status,
    ]).toEqual(statusBefore);
    expect((await sessionRow(a!.sessionId)).table_id).toBe(a!.tableId);
    expect(await tableStatus(a!.tableId)).toBe("occupied");
    expect(await tableStatus(b!.tableId)).toBe("occupied");
    // One linked event per member session, one audit row for the request.
    expect(await eventCount("table_session.linked", a!.sessionId)).toBe(1);
    expect(await eventCount("table_session.linked", b!.sessionId)).toBe(1);
    // At least one audit row names the group (the implementation may write one
    // per member event or one per request; the brief says "one audit row").
    expect(await auditRowsMentioning(group.id)).toBeGreaterThanOrEqual(1);
  });

  it("links sessions that are pending confirmation, open or asked for the bill", async () => {
    const pending = await pendingSession();
    const open = await openSession();
    const billAsked = await openSession();
    await owner.query(
      "UPDATE table_sessions SET status = 'bill_requested', bill_requested_at = now() WHERE id = $1",
      [billAsked.sessionId],
    );

    const response = await linkReq([
      pending.tableId,
      open.tableId,
      billAsked.tableId,
    ]);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.group.members).toHaveLength(3);
    expect((await sessionRow(pending.sessionId)).status).toBe(
      "pending_confirmation",
    );
    expect((await sessionRow(billAsked.sessionId)).status).toBe(
      "bill_requested",
    );
  });

  it("answers the same group again for a repeated request, with no new events", async () => {
    const [a, b] = await openSessions(2);
    const first = await linkReq([a!.tableId, b!.tableId]);
    expect(first.status).toBe(200);
    const groupId = first.body.data.group.id as string;
    const auditAfterFirst = await auditRowsMentioning(groupId);
    expect(auditAfterFirst).toBeGreaterThanOrEqual(1);

    const again = await linkReq([a!.tableId, b!.tableId]);
    const reversed = await linkReq([b!.tableId, a!.tableId]);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.group.id).toBe(groupId);
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.data.group.id).toBe(groupId);
    expect(await eventCount("table_session.linked", a!.sessionId)).toBe(1);
    expect(await eventCount("table_session.linked", b!.sessionId)).toBe(1);
    expect(await auditRowsMentioning(groupId)).toBe(auditAfterFirst);
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
  });

  it("adds a third table to an existing group with groupId", async () => {
    const [a, b, c] = await openSessions(3);
    const groupId = await linkSeats([a!, b!]);

    const response = await linkReq([c!.tableId], { groupId });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.group.id).toBe(groupId);
    expect(response.body.data.group.members).toHaveLength(3);
    await expectGroupOnBoard([a!.tableId, b!.tableId, c!.tableId], groupId);
    expect(await eventCount("table_session.linked", c!.sessionId)).toBe(1);
  });

  describe("refusals write nothing", () => {
    async function expectRefused(
      members: string[],
      extra: Record<string, unknown> = {},
      allowed = [400, 409, 422],
    ) {
      const before = await linkRowCounts(members);
      const response = await linkReq(members, extra);
      // 404 is excluded by default on purpose: it is what a missing route answers.
      expect(allowed, JSON.stringify(response.body)).toContain(response.status);
      expect(await linkRowCounts(members)).toEqual(before);
    }

    it("a table without an active session", async () => {
      const seated = await openSession();
      const empty = await emptyTable();
      await expectRefused([seated.tableId, empty]);
      await expectNoGroupOnBoard(seated.tableId);
    });

    it("a table whose session is closed", async () => {
      const seated = await openSession();
      const closed = await openSession();
      expect((await closeReq(closed.sessionId)).status).toBe(200);
      await expectRefused([seated.tableId, closed.tableId]);
    });

    it("a table whose session is voided", async () => {
      const seated = await openSession();
      const voided = await openSession();
      await owner.query(
        "UPDATE table_sessions SET status = 'voided', closed_at = now(), closed_reason = 'voided' WHERE id = $1",
        [voided.sessionId],
      );
      await expectRefused([seated.tableId, voided.tableId]);
    });

    it("a table that is already in another group", async () => {
      const [a, b, c] = await openSessions(3);
      const groupId = await linkSeats([a!, b!]);
      await expectRefused([a!.tableId, c!.tableId]);
      // Adding it to a different existing group is refused as well.
      const [d, e] = await openSessions(2);
      const otherGroupId = await linkSeats([d!, e!]);
      const before = await linkRowCounts([a!.tableId]);
      const moved = await linkReq([a!.tableId], { groupId: otherGroupId });
      expect([400, 409, 422]).toContain(moved.status);
      expect(await linkRowCounts([a!.tableId])).toEqual(before);
      await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
    });

    it("tables of different outlets", async () => {
      const own = await openSession();
      const [otherOutlet] = await outletBFixtures(1);
      await expectRefused([own.tableId, otherOutlet!.tableId]);
    });

    it("a single table without a groupId", async () => {
      const seated = await openSession();
      await expectRefused([seated.tableId]);
    });

    it("duplicate table ids", async () => {
      const [a, b] = await openSessions(2);
      await expectRefused([a!.tableId, a!.tableId, b!.tableId]);
      await expectRefused([a!.tableId, a!.tableId]);
    });

    it("an unknown table id", async () => {
      const seated = await openSession();
      // An unknown table id is "table not found": 404 is allowed here.
      await expectRefused(
        [seated.tableId, randomUUID()],
        {},
        [400, 404, 409, 422],
      );
    });
  });
});

// ===========================================================================
// 2. UNLINK
// ===========================================================================

describe("unlink tables (legend-1nmh)", () => {
  it("removes one of three tables and keeps the group of two", async () => {
    const [a, b, c] = await openSessions(3);
    const groupId = await linkSeats([a!, b!, c!]);

    const response = await unlinkReq(groupId, { tableIds: [c!.tableId] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.unlinkedTableIds).toEqual([c!.tableId]);
    expect(response.body.data.group.id).toBe(groupId);
    expect(
      response.body.data.group.members
        .map((member: { tableId: string }) => member.tableId)
        .sort(),
    ).toEqual([a!.tableId, b!.tableId].sort());
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
    await expectNoGroupOnBoard(c!.tableId);
    expect(await unlinkedReasons(c!.sessionId)).toEqual(["staff"]);
    expect(await unlinkedReasons(a!.sessionId)).toEqual([]);
    // Service only: sessions stay open, tables stay occupied.
    expect((await sessionRow(c!.sessionId)).status).toBe("open");
    expect(await tableStatus(c!.tableId)).toBe("occupied");
  });

  it("dissolves the group when fewer than two members remain", async () => {
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    await seedOrder(a!.sessionId, 22000);
    const billBefore = await billOf(a!.sessionId);

    const response = await unlinkReq(groupId, { tableIds: [b!.tableId] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.group).toBeNull();
    expect(response.body.data.unlinkedTableIds).toContain(b!.tableId);
    expect(await unlinkedReasons(b!.sessionId)).toEqual(["staff"]);
    expect(await unlinkedReasons(a!.sessionId)).toEqual(["group_dissolved"]);
    await expectNoGroupOnBoard(a!.tableId);
    await expectNoGroupOnBoard(b!.tableId);
    const { rows } = await owner.query<{ dissolved_at: Date | null }>(
      "SELECT dissolved_at FROM table_link_groups WHERE id = $1",
      [groupId],
    );
    expect(rows[0]?.dissolved_at).not.toBeNull();
    expect(await billOf(a!.sessionId)).toBe(billBefore);
    expect((await sessionRow(a!.sessionId)).status).toBe("open");
  });

  it("dissolves the whole group when no tableIds are given", async () => {
    const [a, b, c] = await openSessions(3);
    const groupId = await linkSeats([a!, b!, c!]);

    const response = await unlinkReq(groupId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.group).toBeNull();
    expect([...response.body.data.unlinkedTableIds].sort()).toEqual(
      [a!.tableId, b!.tableId, c!.tableId].sort(),
    );
    for (const seat of [a!, b!, c!]) {
      const reasons = await unlinkedReasons(seat.sessionId);
      expect(reasons).toHaveLength(1);
      expect(["staff", "group_dissolved"]).toContain(reasons[0]);
      await expectNoGroupOnBoard(seat.tableId);
    }
  });

  it("answers 200 and emits nothing when unlinking again", async () => {
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    expect((await unlinkReq(groupId)).status).toBe(200);
    const before = [
      await eventCount("table_session.unlinked", a!.sessionId),
      await eventCount("table_session.unlinked", b!.sessionId),
    ];
    const auditBefore = await auditRowsMentioning(groupId);

    const again = await unlinkReq(groupId);
    const againNamed = await unlinkReq(groupId, { tableIds: [a!.tableId] });

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.group).toBeNull();
    expect(again.body.data.unlinkedTableIds).toEqual([]);
    expect(againNamed.status, JSON.stringify(againNamed.body)).toBe(200);
    expect([
      await eventCount("table_session.unlinked", a!.sessionId),
      await eventCount("table_session.unlinked", b!.sessionId),
    ]).toEqual(before);
    expect(await auditRowsMentioning(groupId)).toBe(auditBefore);
  });

  it("lets a freed table join a new group after unlink", async () => {
    const [a, b, c] = await openSessions(3);
    const groupId = await linkSeats([a!, b!]);
    expect((await unlinkReq(groupId)).status).toBe(200);

    const newGroupId = await linkSeats([a!, c!]);

    expect(newGroupId).not.toBe(groupId);
    await expectGroupOnBoard([a!.tableId, c!.tableId], newGroupId);
    await expectNoGroupOnBoard(b!.tableId);
  });
});

// ===========================================================================
// 3. AUTOMATIC UNLINK AND SESSION OPERATIONS
// ===========================================================================

describe("link follows the session (legend-1nmh)", () => {
  it("closing a member session releases it, frees its table and dissolves a group of two", async () => {
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    await seedOrder(b!.sessionId, 30000, 2);
    const billBefore = await billOf(b!.sessionId);

    const closed = await closeReq(a!.sessionId);

    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await tableStatus(a!.tableId)).toBe("available");
    expect(await unlinkedReasons(a!.sessionId)).toEqual(["session_closed"]);
    expect(await unlinkedReasons(b!.sessionId)).toEqual(["group_dissolved"]);
    await expectNoGroupOnBoard(a!.tableId);
    await expectNoGroupOnBoard(b!.tableId);
    // The other member keeps its session, its table and its bill.
    expect((await sessionRow(b!.sessionId)).status).toBe("open");
    expect(await tableStatus(b!.tableId)).toBe("occupied");
    expect(await billOf(b!.sessionId)).toBe(billBefore);
    const row = await boardRow(b!.tableId);
    expect(row.session?.id).toBe(b!.sessionId);
    const { rows } = await owner.query<{ dissolved_at: Date | null }>(
      "SELECT dissolved_at FROM table_link_groups WHERE id = $1",
      [groupId],
    );
    expect(rows[0]?.dissolved_at).not.toBeNull();
  });

  it("closing one of three member sessions keeps a group of two", async () => {
    const [a, b, c] = await openSessions(3);
    const groupId = await linkSeats([a!, b!, c!]);

    expect((await closeReq(c!.sessionId)).status).toBe(200);

    expect(await unlinkedReasons(c!.sessionId)).toEqual(["session_closed"]);
    expect(await unlinkedReasons(a!.sessionId)).toEqual([]);
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
    await expectNoGroupOnBoard(c!.tableId);
    expect(await tableStatus(c!.tableId)).toBe("available");
  });

  it("keeps a moved session in its group under the new table id", async () => {
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    const target = await emptyTable();

    const moved = await moveReq(a!.sessionId, target);

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await expectGroupOnBoard([target, b!.tableId], groupId);
    await expectNoGroupOnBoard(a!.tableId);
    expect(await unlinkedReasons(a!.sessionId)).toEqual([]);
    expect(await unlinkedReasons(b!.sessionId)).toEqual([]);
    // The group can still be dissolved by the new table id.
    const unlinked = await unlinkReq(groupId, { tableIds: [target] });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data.unlinkedTableIds).toContain(target);
  });

  it("releases a linked merge source with reason session_merged", async () => {
    const [source, other] = await openSessions(2);
    const [targetSeat] = await openSessions(1);
    const groupId = await linkSeats([source!, other!]);
    await seedOrder(source!.sessionId, 12500, 2);
    const mergedBill =
      (await billOf(source!.sessionId)) + (await billOf(targetSeat!.sessionId));

    const merged = await mergeReq(targetSeat!.sessionId, source!.sessionId);

    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(await unlinkedReasons(source!.sessionId)).toEqual([
      "session_merged",
    ]);
    expect(await unlinkedReasons(other!.sessionId)).toEqual([
      "group_dissolved",
    ]);
    await expectNoGroupOnBoard(source!.tableId);
    await expectNoGroupOnBoard(other!.tableId);
    expect(await billOf(targetSeat!.sessionId)).toBe(mergedBill);
    expect((await sessionRow(other!.sessionId)).status).toBe("open");
    expect(groupId).toEqual(expect.any(String));
  });
});

// ===========================================================================
// 4. table.status_changed
// ===========================================================================

describe("table.status_changed event (legend-1nmh)", () => {
  it("is emitted once for a staff status action", async () => {
    const tableId = await emptyTable();
    expect(await eventCount("table.status_changed", tableId)).toBe(0);

    const dirty = await staff.client
      .post(`/api/tables/${tableId}/status`)
      .set(originHeader)
      .send({ action: "mark_dirty" });

    expect(dirty.status, JSON.stringify(dirty.body)).toBe(200);
    const events = await eventsOf("table.status_changed", tableId);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"from":"available"');
    expect(events[0]).toContain('"to":"dirty"');
    expect(events[0]).toContain('"cause":"staff_action"');

    const available = await staff.client
      .post(`/api/tables/${tableId}/status`)
      .set(originHeader)
      .send({ action: "mark_available" });
    expect(available.status).toBe(200);
    const after = await eventsOf("table.status_changed", tableId);
    expect(after).toHaveLength(2);
    expect(after.some((event) => event.includes('"from":"dirty"'))).toBe(true);
  });

  it("is emitted once when closing a session frees the table", async () => {
    const seat = await openSession();
    const before = await eventCount("table.status_changed", seat.tableId);

    expect((await closeReq(seat.sessionId)).status).toBe(200);

    const events = await eventsOf("table.status_changed", seat.tableId);
    expect(events).toHaveLength(before + 1);
    const closedEvent = events.find((event) =>
      event.includes('"cause":"session_closed"'),
    );
    expect(closedEvent).toBeDefined();
    expect(closedEvent).toContain('"from":"occupied"');
    expect(closedEvent).toContain('"to":"available"');
  });

  it("is not emitted when a refused status action changes nothing", async () => {
    const seat = await openSession();
    const before = await eventCount("table.status_changed", seat.tableId);
    const refused = await staff.client
      .post(`/api/tables/${seat.tableId}/status`)
      .set(originHeader)
      .send({ action: "mark_dirty" });
    expect(refused.status).toBe(409);
    expect(await eventCount("table.status_changed", seat.tableId)).toBe(before);
  });
});

// ===========================================================================
// 5. ACCESS
// ===========================================================================

describe("table link access (legend-1nmh)", () => {
  it("answers 401 to a visitor who is not signed in", async () => {
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    const visitor = agent(app);
    const linked = await linkReq([a!.tableId, b!.tableId], {}, visitor);
    const unlinked = await unlinkReq(groupId, {}, visitor);
    expect(linked.status).toBe(401);
    expect(unlinked.status).toBe(401);
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
  });

  it("answers 403 when the request does not come from a trusted origin", async () => {
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    const linked = await staff.client
      .post("/api/table-links")
      .send({ tableIds: [a!.tableId, b!.tableId] });
    const unlinked = await staff.client
      .post(`/api/table-links/${groupId}/unlink`)
      .send({});
    expect(linked.status).toBe(403);
    expect(unlinked.status).toBe(403);
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
  });

  it("answers 403 to an account without the floor.table.operate permission", async () => {
    const [a, b, c, d] = await openSessions(4);
    const groupId = await linkSeats([a!, b!]);
    const noRole = agent(app);
    await signUp(noRole, "No Operate Role");
    const before = await linkRowCounts([c!.tableId, d!.tableId]);

    const linked = await linkReq([c!.tableId, d!.tableId], {}, noRole);
    const unlinked = await unlinkReq(groupId, {}, noRole);

    expect(linked.status).toBe(403);
    expect(unlinked.status).toBe(403);
    expect(await linkRowCounts([c!.tableId, d!.tableId])).toEqual(before);
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
  });

  it("hides another tenant's tables and groups behind a 404", async () => {
    isolated ??= await createIsolatedTenant(`link-${randomUUID().slice(0, 6)}`);
    const tenantTwo = await staffOfIsolatedTenant(app, isolated);
    const headers = { Host: isolated.hostname };
    const [a, b] = await openSessions(2);
    const groupId = await linkSeats([a!, b!]);
    const [c, d] = await openSessions(2);
    const before = await linkRowCounts([c!.tableId, d!.tableId]);

    const linked = await tenantTwo.client
      .post("/api/table-links")
      .set(headers)
      .set(originHeader)
      .send({ tableIds: [c!.tableId, d!.tableId] });
    const unlinked = await tenantTwo.client
      .post(`/api/table-links/${groupId}/unlink`)
      .set(headers)
      .set(originHeader)
      .send({});

    expect(linked.status).toBe(404);
    expect(unlinked.status).toBe(404);
    expect(await linkRowCounts([c!.tableId, d!.tableId])).toEqual(before);
    await expectGroupOnBoard([a!.tableId, b!.tableId], groupId);
  });

  it("refuses a supervisor of outlet A tables and groups of outlet B", async () => {
    const [b1, b2, b3, b4] = await outletBFixtures(4);
    const groupId = await linkSeats([b1!, b2!]);
    const supervisor = await staffWithRole(app, {
      template: "supervisor",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Link Outlet A Supervisor",
    });
    const before = await linkRowCounts([b3!.tableId, b4!.tableId]);

    // Outlet row security hides the rows (404) or the guard refuses (403).
    const linked = await linkReq(
      [b3!.tableId, b4!.tableId],
      {},
      supervisor.client,
    );
    const unlinked = await unlinkReq(groupId, {}, supervisor.client);

    expect([403, 404]).toContain(linked.status);
    expect([403, 404]).toContain(unlinked.status);
    expect(await linkRowCounts([b3!.tableId, b4!.tableId])).toEqual(before);
    await expectGroupOnBoard(
      [b1!.tableId, b2!.tableId],
      groupId,
      seededOutletB,
    );
  });
});
