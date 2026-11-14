// Expo board, runner list, runner assignment and "diantar" (bead legend-mzhr0
// follow-up legend-him8j; PRD v1.7 §3 F12 "Expo"; contract @starter/shared/kitchen
// `expoBoardSchema`, `expoTicketSchema`, `expoRunnerSchema`, `expoDeliveryBlock`;
// table `expo_assignments` legend-aiksz).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in fresh isolated tenants. Fixtures (orders, stations,
// kitchen tickets, table sessions, pickup calls, role assignments) are written as
// the migration owner with the tenant settings applied (FORCE RLS); behaviour
// runs through the service on its own transactions or through HTTP.
//
// Assumptions where the contract is silent (same as pickup.test.ts):
//  - A service-level scope or tenant mismatch is a thrown CoreError
//    (OUTLET_OUT_OF_SCOPE) or HttpError (404); over HTTP that is 403 / 404.
//  - The audit rows of assign and delivered are `audit_logs` rows with
//    objectType 'order' and objectId = the order ULID; the action name is
//    matched loosely (`assign` / `deliver`).
//  - Reassigning before delivery stamps a runnerAssignedAt no earlier than the
//    first one (the exact value is not asserted).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  expoBoardSchema,
  expoRunnerSchema,
  expoTicketSchema,
  type ExpoTicket,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assignExpoRunner,
  listExpoRunners,
  markExpoOrderDelivered,
  readExpoBoard,
} from "../services/expo.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const CLOCK = { timeZone: "Asia/Jakarta", cutoff: "04:00" };
const ROLE_OPERATE = randomUUID();
const ROLE_STAFF = randomUUID(); // no kds.expo.operate: staff who may run, not operate
const MINUTE = 60_000;

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA1: string;
let outletA2: string;
let outletB1: string;

type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  name: string;
};
let operator: Member; // kds.expo.operate, tenant scope
let operatorA1: Member; // kds.expo.operate, outlet A1 only
let noAccess: Member; // role without kds.expo.operate
let operatorB: Member; // kds.expo.operate in tenant B
let runner1: Member; // tenant-scope staff of tenant A (live)
let runner2: Member;

// ---- Fixtures ----------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

function contextOf(
  tenantId: string,
  outletIds?: string[],
): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

const ctxA = () => contextOf(tenantA.tenantId);
const ctxB = () => contextOf(tenantB.tenantId);
const actorOf = (who: Member) => ({ userId: who.userId, deviceId: null });

/** A new outlet of the tenant, so a test gets its own board. */
async function createOutlet(forTenant: IsolatedTenant): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Expo', 'Jl. Uji 3', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        id,
        `EX-${randomUUID().slice(0, 8)}`.toUpperCase(),
        forTenant.tenantId,
        forTenant.outletId,
      ],
    ),
  );
  return id;
}

const nowDate = () => businessDateOf(new Date(), CLOCK);
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function seedStation(
  forTenant: IsolatedTenant,
  outletId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'hot_kitchen')`,
      [id, forTenant.tenantId, outletId, name],
    ),
  );
  return id;
}

/** A second brand of the tenant. */
async function createBrand(forTenant: IsolatedTenant): Promise<string> {
  const id = randomUUID();
  const slug = `br-${randomUUID().slice(0, 8)}`;
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
      [id, forTenant.tenantId, slug, `Brand ${slug}`],
    ),
  );
  return id;
}

/** A new outlet of the tenant under the given brand. */
async function createOutletOfBrand(
  forTenant: IsolatedTenant,
  brandId: string,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, $5, legal_entity_id, $2, 'Outlet Merek Lain', 'Jl. Uji 4', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        id,
        `EX-${randomUUID().slice(0, 8)}`.toUpperCase(),
        forTenant.tenantId,
        forTenant.outletId,
        brandId,
      ],
    ),
  );
  return id;
}

/** A table with an open session; returns the session id (uuid). */
async function seedTableSession(
  forTenant: IsolatedTenant,
  outletId: string,
  code: string,
): Promise<string> {
  const zoneId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  await asOwnerTenant(forTenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [zoneId, forTenant.tenantId, outletId, `Zona ${code}`],
    );
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', '{}')`,
      [tableId, forTenant.tenantId, outletId, zoneId, code],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed')`,
      [
        sessionId,
        forTenant.tenantId,
        outletId,
        tableId,
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
  });
  return sessionId;
}

/** Inserts an order and returns its ULID (the form the service takes). */
async function seedOrder(
  forTenant: IsolatedTenant,
  outletId: string,
  input: {
    channel?: string;
    serviceType?: "dine_in" | "takeaway" | "delivery";
    status?: string;
    businessDate?: string;
    tableSessionId?: string;
  } = {},
): Promise<string> {
  const ulid = createUlid();
  const status = input.status ?? "sent";
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at, voided_at, void_reason, table_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pay_first', 10000, 0, 0, 0, 0, 10000,
         $7, $8, now(), $9, $10, $11)`,
      [
        ulidToUuid(ulid),
        forTenant.tenantId,
        outletId,
        `EX-${ulid.slice(-10)}`,
        input.channel ?? "pos",
        input.serviceType ?? "dine_in",
        status,
        input.businessDate ?? nowDate(),
        status === "voided" ? new Date() : null,
        status === "voided" ? "Batal di kasir" : null,
        input.tableSessionId ?? null,
      ],
    ),
  );
  return ulid;
}

interface TicketSeed {
  stationId: string;
  status?: "new" | "in_progress" | "done" | "recalled" | "cancelled";
  firedAt?: Date;
  doneAt?: Date | null;
}

/** Inserts one kitchen ticket of the order; returns its ULID. */
async function seedTicket(
  forTenant: IsolatedTenant,
  outletId: string,
  orderUlid: string,
  input: TicketSeed,
): Promise<string> {
  const ulid = createUlid();
  const status = input.status ?? "done";
  const firedAt = input.firedAt ?? new Date(Date.now() - 20 * MINUTE);
  const doneAt =
    input.doneAt === undefined
      ? status === "done"
        ? new Date(firedAt.getTime() + 5 * MINUTE)
        : null
      : input.doneAt;
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id,
         business_date, ticket_no, status, priority, fired_at, done_at, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), $7, 0, $8, $9, $10)`,
      [
        ulidToUuid(ulid),
        forTenant.tenantId,
        outletId,
        ulidToUuid(orderUlid),
        input.stationId,
        ulidToUuid(createUlid()),
        status,
        firedAt,
        doneAt,
        status === "cancelled" ? firedAt : null,
      ],
    ),
  );
  return ulid;
}

/** An order with one done ticket on a fresh station: ready to be delivered. */
async function seedReadyOrder(
  forTenant: IsolatedTenant,
  outletId: string,
): Promise<string> {
  const orderId = await seedOrder(forTenant, outletId);
  const station = await seedStation(forTenant, outletId, "Dapur Siap");
  await seedTicket(forTenant, outletId, orderId, { stationId: station });
  return orderId;
}

/** An order with one in-progress ticket: not complete. */
async function seedCookingOrder(
  forTenant: IsolatedTenant,
  outletId: string,
): Promise<string> {
  const orderId = await seedOrder(forTenant, outletId);
  const station = await seedStation(forTenant, outletId, "Dapur Masak");
  await seedTicket(forTenant, outletId, orderId, {
    stationId: station,
    status: "in_progress",
  });
  return orderId;
}

async function seedPickupCall(
  forTenant: IsolatedTenant,
  outletId: string,
  orderUlid: string,
  number: number,
  input: {
    status?: "assigned" | "called" | "picked_up";
    businessDate?: string;
  } = {},
) {
  const status = input.status ?? "assigned";
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pickup_calls (id, tenant_id, outlet_id, order_id, channel, number, business_date,
         status, called_at, picked_up_at)
       VALUES ($1, $2, $3, $4, 'takeaway', $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        forTenant.tenantId,
        outletId,
        ulidToUuid(orderUlid),
        number,
        input.businessDate ?? nowDate(),
        status,
        status === "assigned" ? null : "2031-03-15T10:00:00.000Z",
        status === "picked_up" ? "2031-03-15T10:05:00.000Z" : null,
      ],
    ),
  );
}

async function seedAssignment(
  forTenant: IsolatedTenant,
  outletId: string,
  orderUlid: string,
  input: { runnerId: string; assignedAt: Date; deliveredAt?: Date },
) {
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO expo_assignments (tenant_id, outlet_id, order_id, runner_id, runner_assigned_at,
         assigned_by, delivered_at, delivered_by)
       VALUES ($1, $2, $3, $4, $5, $4, $6, $7)`,
      [
        forTenant.tenantId,
        outletId,
        ulidToUuid(orderUlid),
        input.runnerId,
        input.assignedAt,
        input.deliveredAt ?? null,
        input.deliveredAt ? input.runnerId : null,
      ],
    ),
  );
}

interface AssignmentRow {
  runner_id: string;
  runner_assigned_at: Date;
  assigned_by: string | null;
  delivered_at: Date | null;
  delivered_by: string | null;
}

async function assignmentRows(
  forTenant: IsolatedTenant,
  orderUlid: string,
): Promise<AssignmentRow[]> {
  return asOwnerTenant(forTenant.tenantId, async (client) => {
    const result = await client.query<AssignmentRow>(
      `SELECT runner_id, runner_assigned_at, assigned_by, delivered_at, delivered_by
       FROM expo_assignments WHERE tenant_id = $1 AND order_id = $2`,
      [forTenant.tenantId, ulidToUuid(orderUlid)],
    );
    return result.rows;
  });
}

interface AuditRow {
  event: {
    action: string;
    actorId: string | null;
    outletId: string | null;
    objectType: string;
    objectId: string;
  };
}

async function auditRows(
  forTenant: IsolatedTenant,
  orderUlid: string,
  actionLike: string,
): Promise<AuditRow[]> {
  return asOwnerTenant(forTenant.tenantId, async (client) => {
    const result = await client.query<AuditRow>(
      `SELECT event FROM audit_logs
       WHERE tenant_id = $1 AND event->>'objectType' = 'order'
         AND event->>'objectId' = $2 AND event->>'action' ILIKE $3`,
      [forTenant.tenantId, orderUlid, actionLike],
    );
    return result.rows;
  });
}

async function createUser(label: string): Promise<Member> {
  const client = agent(app);
  const name = `${label} ${randomUUID().slice(0, 4)}`;
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string, name };
}

async function grant(
  forTenant: IsolatedTenant,
  userId: string,
  roleId: string,
  scope: { type: "tenant" | "brand" | "outlet" | "station"; id: string | null },
  window: { from?: Date; until?: Date | null } = {},
) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $2)`,
    [
      forTenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.id,
      window.from ?? new Date(Date.now() - 5 * MINUTE),
      window.until ?? null,
    ],
  );
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet"; id: string | null },
  label: string,
): Promise<Member> {
  const user = await createUser(label);
  await grant(forTenant, user.userId, roleId, scope);
  return user;
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [
      id,
      tenantId,
      name,
      JSON.stringify(permissions),
      JSON.stringify(["tenant", "outlet"]),
    ],
  );
}

// ---- HTTP helpers ------------------------------------------------------------

function api(
  who: Member | null,
  forTenant: IsolatedTenant,
  outletId: string,
  extraHeaders: Record<string, string> = originHeader,
) {
  const client = who?.client ?? agent(app);
  const base = `/api/outlets/${encodeURIComponent(outletId)}`;
  const hostHeader = { Host: forTenant.hostname };
  return {
    board: () => client.get(`${base}/expo`).set(hostHeader).set(extraHeaders),
    runners: () =>
      client.get(`${base}/expo/runners`).set(hostHeader).set(extraHeaders),
    assign: (orderId: string, body: unknown) =>
      client
        .post(`${base}/expo/${orderId}/runner`)
        .set(hostHeader)
        .set(extraHeaders)
        .send(body as object),
    delivered: (orderId: string) =>
      client
        .post(`${base}/expo/${orderId}/delivered`)
        .set(hostHeader)
        .set(extraHeaders)
        .send({}),
  };
}

const iso = (date: Date) => date.toISOString();

function ticketOf(
  board: { tickets: ExpoTicket[] },
  orderId: string,
): ExpoTicket {
  const found = board.tickets.find((t) => t.orderId === orderId);
  if (!found) throw new Error(`Order ${orderId} not on the expo board`);
  return found;
}

beforeAll(async () => {
  app = createApp();
  tenantA = await createIsolatedTenant(`ex-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`exb-${randomUUID().slice(0, 6)}`);
  outletA1 = tenantA.outletId;
  outletA2 = await createOutlet(tenantA);
  outletB1 = tenantB.outletId;

  await insertRole(tenantA.tenantId, ROLE_OPERATE, "Expo Operator Uji", [
    "kds.expo.operate",
  ]);
  await insertRole(tenantA.tenantId, ROLE_STAFF, "Expo Staf Uji", [
    "order.view",
  ]);
  const roleB = randomUUID();
  await insertRole(tenantB.tenantId, roleB, "Expo Operator B", [
    "kds.expo.operate",
  ]);

  operator = await member(
    tenantA,
    ROLE_OPERATE,
    { type: "tenant", id: null },
    "Expo Operator",
  );
  operatorA1 = await member(
    tenantA,
    ROLE_OPERATE,
    { type: "outlet", id: outletA1 },
    "Expo Operator A1",
  );
  noAccess = await member(
    tenantA,
    ROLE_STAFF,
    { type: "tenant", id: null },
    "Expo Tanpa Akses",
  );
  operatorB = await member(
    tenantB,
    roleB,
    { type: "tenant", id: null },
    "Expo Operator B",
  );
  runner1 = await member(
    tenantA,
    ROLE_STAFF,
    { type: "tenant", id: null },
    "Runner Satu",
  );
  runner2 = await member(
    tenantA,
    ROLE_STAFF,
    { type: "tenant", id: null },
    "Runner Dua",
  );
});

afterAll(async () => {
  // Orders and tickets stay in the disposable database; give the tenants a
  // valid creator so the platform tenant list parses (as pickup.test.ts does).
  for (const t of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Board -------------------------------------------------------------------

describe("expo board", () => {
  it("lists a dine-in order across stations with table label, completeness and readyAt", async () => {
    const outlet = await createOutlet(tenantA);
    const session = await seedTableSession(tenantA, outlet, "A12");
    const orderId = await seedOrder(tenantA, outlet, {
      channel: "pos",
      serviceType: "dine_in",
      tableSessionId: session,
    });
    const grill = await seedStation(tenantA, outlet, "Dapur Panas");
    const bar = await seedStation(tenantA, outlet, "Bar Kopi");
    const fired = new Date(Date.now() - 30 * MINUTE);
    const grillDone = new Date(fired.getTime() + 8 * MINUTE);
    const barDone = new Date(fired.getTime() + 12 * MINUTE);
    const grillTicket = await seedTicket(tenantA, outlet, orderId, {
      stationId: grill,
      status: "done",
      firedAt: fired,
      doneAt: grillDone,
    });
    const barTicket = await seedTicket(tenantA, outlet, orderId, {
      stationId: bar,
      status: "in_progress",
      firedAt: fired,
    });

    const now = new Date();
    const board = expoBoardSchema.parse(
      await readExpoBoard(ctxA(), outlet, now),
    );
    expect(board.tenantId).toBe(tenantA.tenantId);
    expect(board.outletId).toBe(outlet);
    expect(new Date(board.generatedAt).getTime()).toBe(now.getTime());
    expect(board.tickets).toHaveLength(1);

    const open = ticketOf(board, orderId);
    expect(open.tenantId).toBe(tenantA.tenantId);
    expect(open.outletId).toBe(outlet);
    expect(open.channel).toBe("dine_in");
    expect(open.tableLabel).toBe("A12");
    expect(open.pickupNumber).toBeNull();
    expect(open.pickupCode).toBeNull();
    expect(open.isComplete).toBe(false);
    expect(open.readyAt).toBeNull();
    expect(open.runnerId).toBeNull();
    expect(open.runnerAssignedAt).toBeNull();
    expect(open.deliveredAt).toBeNull();
    expect(
      [...open.stations].sort((a, b) =>
        a.stationName.localeCompare(b.stationName),
      ),
    ).toEqual([
      {
        stationId: bar,
        stationName: "Bar Kopi",
        ticketId: barTicket,
        status: "in_progress",
      },
      {
        stationId: grill,
        stationName: "Dapur Panas",
        ticketId: grillTicket,
        status: "done",
      },
    ]);

    // The last station is bumped: complete, readyAt is the latest doneAt.
    await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query(
        `UPDATE kitchen_tickets SET status = 'done', done_at = $3
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA.tenantId, ulidToUuid(barTicket), barDone],
      ),
    );
    const complete = ticketOf(
      await readExpoBoard(ctxA(), outlet, now),
      orderId,
    );
    expect(complete.isComplete).toBe(true);
    expect(complete.readyAt).toBe(iso(barDone));
  });

  it("leaves out cancelled tickets, and an order with a done and a cancelled ticket is complete", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedOrder(tenantA, outlet);
    const kitchen = await seedStation(tenantA, outlet, "Dapur Utama");
    const salad = await seedStation(tenantA, outlet, "Cold Kitchen");
    const doneAt = new Date(Date.now() - 10 * MINUTE);
    const kept = await seedTicket(tenantA, outlet, orderId, {
      stationId: kitchen,
      status: "done",
      doneAt,
    });
    await seedTicket(tenantA, outlet, orderId, {
      stationId: salad,
      status: "cancelled",
      doneAt: null,
    });

    const ticket = ticketOf(
      await readExpoBoard(ctxA(), outlet, new Date()),
      orderId,
    );
    expect(ticket.stations.map((s) => s.ticketId)).toEqual([kept]);
    expect(ticket.isComplete).toBe(true);
    expect(ticket.readyAt).toBe(iso(doneAt));
  });

  it("omits orders without an active ticket, voided orders and other outlets", async () => {
    const outlet = await createOutlet(tenantA);
    const otherOutlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const otherStation = await seedStation(tenantA, otherOutlet, "Dapur Lain");

    const shown = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, shown, { stationId: station });

    const noTickets = await seedOrder(tenantA, outlet);
    const cancelledOnly = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, cancelledOnly, {
      stationId: station,
      status: "cancelled",
    });
    const voided = await seedOrder(tenantA, outlet, { status: "voided" });
    await seedTicket(tenantA, outlet, voided, { stationId: station });
    const elsewhere = await seedOrder(tenantA, otherOutlet);
    await seedTicket(tenantA, otherOutlet, elsewhere, {
      stationId: otherStation,
    });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(board.tickets.map((t) => t.orderId)).toEqual([shown]);
    for (const absent of [noTickets, cancelledOnly, voided, elsewhere])
      expect(board.tickets.map((t) => t.orderId)).not.toContain(absent);
  });

  it("maps the order channel and service type to the expo channel", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const cases: [string, "dine_in" | "takeaway" | "delivery", string][] = [
      ["gofood", "delivery", "gofood"],
      ["grabfood", "delivery", "grabfood"],
      ["shopeefood", "delivery", "shopeefood"],
      ["reservation", "dine_in", "reservation"],
      ["pos", "dine_in", "dine_in"],
      ["qr", "dine_in", "dine_in"],
      ["pos", "takeaway", "takeaway"],
      ["qr", "takeaway", "takeaway"],
      ["pos", "delivery", "takeaway"],
    ];
    const seeded: [string, string][] = [];
    for (const [channel, serviceType, expected] of cases) {
      const orderId = await seedOrder(tenantA, outlet, {
        channel,
        serviceType,
      });
      await seedTicket(tenantA, outlet, orderId, { stationId: station });
      seeded.push([orderId, expected]);
    }
    const board = await readExpoBoard(ctxA(), outlet, new Date());
    for (const [orderId, expected] of seeded)
      expect(ticketOf(board, orderId).channel).toBe(expected);
  });

  it("shows the table label for dine-in only and the pickup number when a call exists", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const takeaway = await seedOrder(tenantA, outlet, {
      channel: "pos",
      serviceType: "takeaway",
    });
    await seedTicket(tenantA, outlet, takeaway, { stationId: station });
    await seedPickupCall(tenantA, outlet, takeaway, 42);
    const bare = await seedOrder(tenantA, outlet, {
      channel: "pos",
      serviceType: "dine_in",
    });
    await seedTicket(tenantA, outlet, bare, { stationId: station });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    const pickup = ticketOf(board, takeaway);
    expect(pickup.pickupNumber).toBe(42);
    expect(pickup.pickupCode).toBe("A-042");
    expect(pickup.tableLabel).toBeNull();
    // Dine-in without a table session has no label and no call number.
    expect(ticketOf(board, bare).tableLabel).toBeNull();
    expect(ticketOf(board, bare).pickupNumber).toBeNull();
    expect(ticketOf(board, bare).pickupCode).toBeNull();
  });

  it("a pickup number past 999 shows its letter code on the ticket (legend-ggpoe)", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const orderId = await seedOrder(tenantA, outlet, {
      channel: "pos",
      serviceType: "delivery",
    });
    await seedTicket(tenantA, outlet, orderId, { stationId: station });
    await seedPickupCall(tenantA, outlet, orderId, 1000);

    const board = expoBoardSchema.parse(
      await readExpoBoard(ctxA(), outlet, new Date()),
    );
    const ticket = ticketOf(board, orderId);
    expect(ticket.pickupNumber).toBe(1000);
    expect(ticket.pickupCode).toBe("B-001");
  });

  it("carries the runner and the delivery from expo_assignments; delivered orders stay listed", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const assignedAt = new Date(Date.now() - 6 * MINUTE);
    const deliveredAt = new Date(Date.now() - 3 * MINUTE);

    const onTheWay = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, onTheWay, { stationId: station });
    await seedAssignment(tenantA, outlet, onTheWay, {
      runnerId: runner1.userId,
      assignedAt,
    });
    const handedOver = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, handedOver, { stationId: station });
    await seedAssignment(tenantA, outlet, handedOver, {
      runnerId: runner2.userId,
      assignedAt,
      deliveredAt,
    });

    const board = expoBoardSchema.parse(
      await readExpoBoard(ctxA(), outlet, new Date()),
    );
    const a = ticketOf(board, onTheWay);
    expect(a.runnerId).toBe(runner1.userId);
    expect(a.runnerAssignedAt).toBe(iso(assignedAt));
    expect(a.deliveredAt).toBeNull();
    const b = ticketOf(board, handedOver);
    expect(b.runnerId).toBe(runner2.userId);
    expect(b.runnerAssignedAt).toBe(iso(assignedAt));
    expect(b.deliveredAt).toBe(iso(deliveredAt));
  });

  it("orders the board by the oldest firedAt first", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const station2 = await seedStation(tenantA, outlet, "Bar Kopi");
    const at = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * MINUTE);

    const mid = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, mid, {
      stationId: station,
      firedAt: at(20),
    });
    const newest = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, newest, {
      stationId: station,
      firedAt: at(5),
    });
    const oldest = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, oldest, {
      stationId: station,
      firedAt: at(2),
    });
    // The oldest ticket of an order decides its place.
    await seedTicket(tenantA, outlet, oldest, {
      stationId: station2,
      firedAt: at(40),
    });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(board.tickets.map((t) => t.orderId)).toEqual([oldest, mid, newest]);
  });

  it("keeps an undelivered order of an earlier business day on the board, cooking or complete", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const yesterday = dayBefore(nowDate());

    const cooking = await seedOrder(tenantA, outlet, {
      businessDate: yesterday,
    });
    await seedTicket(tenantA, outlet, cooking, {
      stationId: station,
      status: "in_progress",
    });
    const complete = await seedOrder(tenantA, outlet, {
      businessDate: yesterday,
    });
    await seedTicket(tenantA, outlet, complete, { stationId: station });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(ticketOf(board, cooking).isComplete).toBe(false);
    expect(ticketOf(board, complete).isComplete).toBe(true);
  });

  it("drops an order delivered on an earlier business day, but keeps one delivered today", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const assignedAt = new Date(Date.now() - 6 * MINUTE);
    const deliveredAt = new Date(Date.now() - 3 * MINUTE);

    const oldDelivered = await seedOrder(tenantA, outlet, {
      businessDate: dayBefore(nowDate()),
    });
    await seedTicket(tenantA, outlet, oldDelivered, { stationId: station });
    await seedAssignment(tenantA, outlet, oldDelivered, {
      runnerId: runner1.userId,
      assignedAt,
      deliveredAt,
    });
    const todayDelivered = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, todayDelivered, { stationId: station });
    await seedAssignment(tenantA, outlet, todayDelivered, {
      runnerId: runner1.userId,
      assignedAt,
      deliveredAt,
    });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(board.tickets.map((t) => t.orderId)).toEqual([todayDelivered]);
  });

  it("drops an earlier-day order whose pickup call is picked_up, but keeps one whose call is called, assigned or absent", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const yesterday = dayBefore(nowDate());
    const seedOld = async () => {
      const orderId = await seedOrder(tenantA, outlet, {
        businessDate: yesterday,
      });
      await seedTicket(tenantA, outlet, orderId, { stationId: station });
      return orderId;
    };

    const pickedUp = await seedOld();
    await seedPickupCall(tenantA, outlet, pickedUp, 1, {
      status: "picked_up",
      businessDate: yesterday,
    });
    const called = await seedOld();
    await seedPickupCall(tenantA, outlet, called, 2, {
      status: "called",
      businessDate: yesterday,
    });
    const assigned = await seedOld();
    await seedPickupCall(tenantA, outlet, assigned, 3, {
      status: "assigned",
      businessDate: yesterday,
    });
    const noCall = await seedOld();

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(board.tickets.map((t) => t.orderId).sort()).toEqual(
      [called, assigned, noCall].sort(),
    );
  });

  it("looks back at most 2 business days: 2 days ago is listed, 3 days ago is not", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const twoAgo = dayBefore(dayBefore(nowDate()));
    const threeAgo = dayBefore(twoAgo);

    const shown = await seedOrder(tenantA, outlet, { businessDate: twoAgo });
    await seedTicket(tenantA, outlet, shown, { stationId: station });
    const tooOld = await seedOrder(tenantA, outlet, { businessDate: threeAgo });
    await seedTicket(tenantA, outlet, tooOld, { stationId: station });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(board.tickets.map((t) => t.orderId)).toEqual([shown]);
  });

  it("puts an older business day before today", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");

    const today = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, today, {
      stationId: station,
      firedAt: new Date(Date.now() - 5 * MINUTE),
    });
    const older = await seedOrder(tenantA, outlet, {
      businessDate: dayBefore(nowDate()),
    });
    await seedTicket(tenantA, outlet, older, {
      stationId: station,
      firedAt: new Date(Date.now() - 20 * 60 * MINUTE),
    });

    const board = await readExpoBoard(ctxA(), outlet, new Date());
    expect(board.tickets.map((t) => t.orderId)).toEqual([older, today]);
  });
});

// ---- Runners -----------------------------------------------------------------

describe("expo runners", () => {
  it("lists staff with a live tenant or this-outlet assignment, sorted by name, and no one else", async () => {
    const tenantR = await createIsolatedTenant(
      `exr-${randomUUID().slice(0, 6)}`,
    );
    const outlet = tenantR.outletId;
    const otherOutlet = await createOutlet(tenantR);
    const role = randomUUID();
    await insertRole(tenantR.tenantId, role, "Runner Uji", ["order.view"]);

    const zed = await createUser("Zed Runner");
    const ani = await createUser("Ani Runner");
    const budi = await createUser("Budi Runner");
    await grant(tenantR, zed.userId, role, { type: "tenant", id: null });
    await grant(tenantR, ani.userId, role, { type: "outlet", id: outlet });
    await grant(tenantR, budi.userId, role, { type: "tenant", id: null });

    const expired = await createUser("Expired Runner");
    await grant(
      tenantR,
      expired.userId,
      role,
      { type: "tenant", id: null },
      {
        from: new Date(Date.now() - 2 * 60 * MINUTE),
        until: new Date(Date.now() - 60 * MINUTE),
      },
    );
    const notYet = await createUser("Future Runner");
    await grant(
      tenantR,
      notYet.userId,
      role,
      { type: "tenant", id: null },
      { from: new Date(Date.now() + 60 * MINUTE) },
    );
    const elsewhere = await createUser("Elsewhere Runner");
    await grant(tenantR, elsewhere.userId, role, {
      type: "outlet",
      id: otherOutlet,
    });
    const nobody = await createUser("Unassigned Runner");
    // A user of another tenant never shows up.
    expect(operatorB.userId).not.toBe(nobody.userId);

    const list = (
      await listExpoRunners(contextOf(tenantR.tenantId), outlet, new Date())
    ).map((r) => expoRunnerSchema.parse(r));
    expect(list.map((r) => r.userId)).toEqual([
      ani.userId,
      budi.userId,
      zed.userId,
    ]);
    expect(list.map((r) => r.name)).toEqual([ani.name, budi.name, zed.name]);
    for (const r of list) {
      expect(r.tenantId).toBe(tenantR.tenantId);
      expect(r.outletId).toBe(outlet);
    }

    // The other outlet sees the tenant-wide staff and its own, not Ani's outlet.
    const other = await listExpoRunners(
      contextOf(tenantR.tenantId),
      otherOutlet,
      new Date(),
    );
    expect(other.map((r) => r.userId).sort()).toEqual(
      [budi.userId, elsewhere.userId, zed.userId].sort(),
    );
  });

  it("lists a brand-scoped runner of the outlet's brand and a station-scoped runner of this outlet's station", async () => {
    const tenantR = await createIsolatedTenant(
      `exr-${randomUUID().slice(0, 6)}`,
    );
    const outlet = tenantR.outletId;
    const role = randomUUID();
    await insertRole(tenantR.tenantId, role, "Runner Uji", ["order.view"]);
    const station = await seedStation(tenantR, outlet, "Pass Runner");

    const brandRunner = await createUser("Brand Runner");
    await grant(tenantR, brandRunner.userId, role, {
      type: "brand",
      id: tenantR.brandId,
    });
    const stationRunner = await createUser("Station Runner");
    await grant(tenantR, stationRunner.userId, role, {
      type: "station",
      id: station,
    });

    const list = await listExpoRunners(
      contextOf(tenantR.tenantId),
      outlet,
      new Date(),
    );
    expect(list.map((r) => r.userId).sort()).toEqual(
      [brandRunner.userId, stationRunner.userId].sort(),
    );
  });

  it("leaves out a runner scoped to another brand, or to a station of another outlet", async () => {
    const tenantR = await createIsolatedTenant(
      `exr-${randomUUID().slice(0, 6)}`,
    );
    const outlet = tenantR.outletId;
    const role = randomUUID();
    await insertRole(tenantR.tenantId, role, "Runner Uji", ["order.view"]);
    const otherBrand = await createBrand(tenantR);
    const otherOutlet = await createOutletOfBrand(tenantR, otherBrand);
    const otherStation = await seedStation(tenantR, otherOutlet, "Pass Lain");

    const otherBrandRunner = await createUser("Brand Lain");
    await grant(tenantR, otherBrandRunner.userId, role, {
      type: "brand",
      id: otherBrand,
    });
    const otherStationRunner = await createUser("Station Lain");
    await grant(tenantR, otherStationRunner.userId, role, {
      type: "station",
      id: otherStation,
    });

    expect(
      await listExpoRunners(contextOf(tenantR.tenantId), outlet, new Date()),
    ).toEqual([]);
    // They do belong to the other outlet.
    const other = await listExpoRunners(
      contextOf(tenantR.tenantId),
      otherOutlet,
      new Date(),
    );
    expect(other.map((r) => r.userId).sort()).toEqual(
      [otherBrandRunner.userId, otherStationRunner.userId].sort(),
    );
  });

  it("leaves out an expired or not-yet-valid brand or station assignment", async () => {
    const tenantR = await createIsolatedTenant(
      `exr-${randomUUID().slice(0, 6)}`,
    );
    const outlet = tenantR.outletId;
    const role = randomUUID();
    await insertRole(tenantR.tenantId, role, "Runner Uji", ["order.view"]);
    const station = await seedStation(tenantR, outlet, "Pass Kedaluwarsa");
    const past = {
      from: new Date(Date.now() - 2 * 60 * MINUTE),
      until: new Date(Date.now() - 60 * MINUTE),
    };

    const expiredBrand = await createUser("Brand Kedaluwarsa");
    await grant(
      tenantR,
      expiredBrand.userId,
      role,
      { type: "brand", id: tenantR.brandId },
      past,
    );
    const expiredStation = await createUser("Station Kedaluwarsa");
    await grant(
      tenantR,
      expiredStation.userId,
      role,
      { type: "station", id: station },
      past,
    );
    const futureBrand = await createUser("Brand Belum Aktif");
    await grant(
      tenantR,
      futureBrand.userId,
      role,
      { type: "brand", id: tenantR.brandId },
      { from: new Date(Date.now() + 60 * MINUTE) },
    );

    expect(
      await listExpoRunners(contextOf(tenantR.tenantId), outlet, new Date()),
    ).toEqual([]);
  });

  it("lists a user with two matching assignments once", async () => {
    const tenantR = await createIsolatedTenant(
      `exr-${randomUUID().slice(0, 6)}`,
    );
    const outlet = tenantR.outletId;
    const role = randomUUID();
    await insertRole(tenantR.tenantId, role, "Runner Uji", ["order.view"]);
    const station = await seedStation(tenantR, outlet, "Pass Ganda");

    const twice = await createUser("Ganda Runner");
    await grant(tenantR, twice.userId, role, { type: "tenant", id: null });
    await grant(tenantR, twice.userId, role, {
      type: "brand",
      id: tenantR.brandId,
    });
    await grant(tenantR, twice.userId, role, { type: "outlet", id: outlet });
    await grant(tenantR, twice.userId, role, { type: "station", id: station });

    const list = await listExpoRunners(
      contextOf(tenantR.tenantId),
      outlet,
      new Date(),
    );
    expect(list.map((r) => r.userId)).toEqual([twice.userId]);
  });

  it("gives a tenant only its own staff: tenant B cannot list tenant A's runners", async () => {
    const own = await listExpoRunners(ctxB(), outletB1, new Date());
    expect(own.map((r) => r.userId)).toEqual([operatorB.userId]);
    await expect(
      listExpoRunners(ctxB(), outletA1, new Date()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---- Assign ------------------------------------------------------------------

describe("assign a runner", () => {
  it("assigns a valid runner and writes runnerId with runnerAssignedAt", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const now = new Date();

    const ticket = expoTicketSchema.parse(
      await assignExpoRunner(
        ctxA(),
        actorOf(operator),
        outlet,
        orderId,
        runner1.userId,
        now,
      ),
    );
    expect(ticket.orderId).toBe(orderId);
    expect(ticket.runnerId).toBe(runner1.userId);
    expect(ticket.runnerAssignedAt).toBe(iso(now));
    expect(ticket.deliveredAt).toBeNull();

    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runner_id).toBe(runner1.userId);
    expect(rows[0]?.assigned_by).toBe(operator.userId);
    expect(rows[0]?.runner_assigned_at.getTime()).toBe(now.getTime());
    expect(rows[0]?.delivered_at).toBeNull();

    // The board shows the same runner.
    const onBoard = ticketOf(await readExpoBoard(ctxA(), outlet, now), orderId);
    expect(onBoard.runnerId).toBe(runner1.userId);
  });

  it("repeating the same runner is 200 and keeps the first runnerAssignedAt", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const first = new Date();
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      first,
    );
    const again = await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      new Date(first.getTime() + 5 * MINUTE),
    );
    expect(again.runnerId).toBe(runner1.userId);
    expect(again.runnerAssignedAt).toBe(iso(first));
    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runner_assigned_at.getTime()).toBe(first.getTime());
  });

  it("reassigning before delivery replaces the runner (still one row)", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const first = new Date();
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      first,
    );
    const second = new Date(first.getTime() + 2 * MINUTE);
    const replaced = await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner2.userId,
      second,
    );
    expect(replaced.runnerId).toBe(runner2.userId);
    expect(
      new Date(replaced.runnerAssignedAt ?? 0).getTime(),
    ).toBeGreaterThanOrEqual(first.getTime());
    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runner_id).toBe(runner2.userId);
  });

  it("422 EXPO_RUNNER_INVALID when the runner is not staff of the outlet", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const otherOutletStaff = await createUser("Staf Outlet Lain");
    await grant(tenantA, otherOutletStaff.userId, ROLE_STAFF, {
      type: "outlet",
      id: outletA2,
    });
    const expired = await createUser("Staf Kedaluwarsa");
    await grant(
      tenantA,
      expired.userId,
      ROLE_STAFF,
      { type: "tenant", id: null },
      {
        from: new Date(Date.now() - 2 * 60 * MINUTE),
        until: new Date(Date.now() - 60 * MINUTE),
      },
    );
    const stranger = await createUser("Bukan Staf");
    for (const candidate of [
      otherOutletStaff.userId,
      expired.userId,
      stranger.userId,
      operatorB.userId, // another tenant's user
      randomUUID(), // no such user
    ])
      await expect(
        assignExpoRunner(
          ctxA(),
          actorOf(operator),
          outlet,
          orderId,
          candidate,
          new Date(),
        ),
      ).rejects.toMatchObject({ status: 422, code: "EXPO_RUNNER_INVALID" });
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);
  });

  it("assigns a brand-scoped runner of the outlet's brand and a station-scoped runner of the outlet's station", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const station = await seedStation(tenantA, outlet, "Pass Assign");
    const brandRunner = await createUser("Brand Assign");
    await grant(tenantA, brandRunner.userId, ROLE_STAFF, {
      type: "brand",
      id: tenantA.brandId,
    });
    const stationRunner = await createUser("Station Assign");
    await grant(tenantA, stationRunner.userId, ROLE_STAFF, {
      type: "station",
      id: station,
    });

    for (const candidate of [brandRunner, stationRunner]) {
      const ticket = await assignExpoRunner(
        ctxA(),
        actorOf(operator),
        outlet,
        orderId,
        candidate.userId,
        new Date(),
      );
      expect(ticket.runnerId).toBe(candidate.userId);
    }
  });

  it("422 EXPO_RUNNER_INVALID for a runner scoped to another brand, a station of another outlet, or an expired brand or station", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const station = await seedStation(tenantA, outlet, "Pass Kedaluwarsa");
    const otherBrand = await createBrand(tenantA);
    const otherOutlet = await createOutletOfBrand(tenantA, otherBrand);
    const otherStation = await seedStation(tenantA, otherOutlet, "Pass Lain");
    const past = {
      from: new Date(Date.now() - 2 * 60 * MINUTE),
      until: new Date(Date.now() - 60 * MINUTE),
    };

    const otherBrandRunner = await createUser("Brand Lain");
    await grant(tenantA, otherBrandRunner.userId, ROLE_STAFF, {
      type: "brand",
      id: otherBrand,
    });
    const otherStationRunner = await createUser("Station Lain");
    await grant(tenantA, otherStationRunner.userId, ROLE_STAFF, {
      type: "station",
      id: otherStation,
    });
    const expiredBrand = await createUser("Brand Kedaluwarsa");
    await grant(
      tenantA,
      expiredBrand.userId,
      ROLE_STAFF,
      { type: "brand", id: tenantA.brandId },
      past,
    );
    const expiredStation = await createUser("Station Kedaluwarsa");
    await grant(
      tenantA,
      expiredStation.userId,
      ROLE_STAFF,
      { type: "station", id: station },
      past,
    );

    for (const candidate of [
      otherBrandRunner.userId,
      otherStationRunner.userId,
      expiredBrand.userId,
      expiredStation.userId,
    ])
      await expect(
        assignExpoRunner(
          ctxA(),
          actorOf(operator),
          outlet,
          orderId,
          candidate,
          new Date(),
        ),
      ).rejects.toMatchObject({ status: 422, code: "EXPO_RUNNER_INVALID" });
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);
  });

  it("after delivery another runner is 409 EXPO_ORDER_DELIVERED; the same runner is 200 unchanged", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const assignedAt = new Date(Date.now() - 4 * MINUTE);
    const deliveredAt = new Date(Date.now() - 2 * MINUTE);
    await seedAssignment(tenantA, outlet, orderId, {
      runnerId: runner1.userId,
      assignedAt,
      deliveredAt,
    });

    await expect(
      assignExpoRunner(
        ctxA(),
        actorOf(operator),
        outlet,
        orderId,
        runner2.userId,
        new Date(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "EXPO_ORDER_DELIVERED" });

    const same = await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      new Date(),
    );
    expect(same.runnerId).toBe(runner1.userId);
    expect(same.runnerAssignedAt).toBe(iso(assignedAt));
    expect(same.deliveredAt).toBe(iso(deliveredAt));

    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runner_id).toBe(runner1.userId);
    expect(rows[0]?.delivered_at?.getTime()).toBe(deliveredAt.getTime());
  });

  it("404 for an order without an active ticket, an unknown order, another outlet or another tenant", async () => {
    const outlet = await createOutlet(tenantA);
    const station = await seedStation(tenantA, outlet, "Dapur Utama");
    const noTickets = await seedOrder(tenantA, outlet);
    const cancelledOnly = await seedOrder(tenantA, outlet);
    await seedTicket(tenantA, outlet, cancelledOnly, {
      stationId: station,
      status: "cancelled",
    });
    const real = await seedCookingOrder(tenantA, outlet);
    const otherOutlet = await createOutlet(tenantA);

    const attempts: [ScopedTenantContext, string, string][] = [
      [ctxA(), outlet, noTickets],
      [ctxA(), outlet, cancelledOnly],
      [ctxA(), outlet, createUlid()],
      [ctxA(), otherOutlet, real], // same tenant, other outlet path
      [ctxB(), outlet, real], // another tenant
    ];
    for (const [context, outletId, orderId] of attempts)
      await expect(
        assignExpoRunner(
          context,
          actorOf(operator),
          outletId,
          orderId,
          runner1.userId,
          new Date(),
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await assignmentRows(tenantA, real)).toEqual([]);
    expect(await assignmentRows(tenantA, noTickets)).toEqual([]);
  });
});

// ---- Delivered ---------------------------------------------------------------

describe("mark delivered (diantar)", () => {
  it("409 EXPO_ORDER_NOT_COMPLETE while a station is still cooking", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      new Date(),
    );
    await expect(
      markExpoOrderDelivered(
        ctxA(),
        actorOf(runner1),
        outlet,
        orderId,
        new Date(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "EXPO_ORDER_NOT_COMPLETE" });
    expect(
      (await assignmentRows(tenantA, orderId))[0]?.delivered_at,
    ).toBeNull();
  });

  it("409 EXPO_RUNNER_NOT_ASSIGNED when the order is complete but has no runner", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    await expect(
      markExpoOrderDelivered(
        ctxA(),
        actorOf(runner1),
        outlet,
        orderId,
        new Date(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "EXPO_RUNNER_NOT_ASSIGNED" });
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);
  });

  it("stamps deliveredAt and deliveredBy; repeating is 200 with the first deliveredAt", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const assignedAt = new Date();
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      assignedAt,
    );
    const first = new Date(assignedAt.getTime() + MINUTE);
    const done = expoTicketSchema.parse(
      await markExpoOrderDelivered(
        ctxA(),
        actorOf(runner1),
        outlet,
        orderId,
        first,
      ),
    );
    expect(done.deliveredAt).toBe(iso(first));
    expect(done.runnerId).toBe(runner1.userId);
    expect(done.isComplete).toBe(true);

    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered_at?.getTime()).toBe(first.getTime());
    expect(rows[0]?.delivered_by).toBe(runner1.userId);

    const repeat = await markExpoOrderDelivered(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      new Date(first.getTime() + 5 * MINUTE),
    );
    expect(repeat.deliveredAt).toBe(iso(first));
    const after = await assignmentRows(tenantA, orderId);
    expect(after[0]?.delivered_at?.getTime()).toBe(first.getTime());
    expect(after[0]?.delivered_by).toBe(runner1.userId);
  });

  it("clamps deliveredAt to runnerAssignedAt when delivered with an earlier clock", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const now = new Date();
    const assignedAt = new Date(now.getTime() + 1000);
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      assignedAt,
    );
    const done = expoTicketSchema.parse(
      await markExpoOrderDelivered(
        ctxA(),
        actorOf(runner1),
        outlet,
        orderId,
        now,
      ),
    );
    expect(done.deliveredAt).toBe(iso(assignedAt));
    expect(done.runnerAssignedAt).toBe(iso(assignedAt));

    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    const deliveredAt = rows[0]?.delivered_at?.getTime() ?? 0;
    const runnerAssignedAt = rows[0]?.runner_assigned_at.getTime() ?? 0;
    expect(deliveredAt).toBeGreaterThanOrEqual(runnerAssignedAt);
    expect(deliveredAt).toBe(assignedAt.getTime());
  });

  it("404 for a missing order, another outlet or another tenant", async () => {
    const outlet = await createOutlet(tenantA);
    const otherOutlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      new Date(),
    );
    const attempts: [ScopedTenantContext, string, string][] = [
      [ctxA(), outlet, createUlid()],
      [ctxA(), otherOutlet, orderId],
      [ctxB(), outlet, orderId],
    ];
    for (const [context, outletId, id] of attempts)
      await expect(
        markExpoOrderDelivered(
          context,
          actorOf(runner1),
          outletId,
          id,
          new Date(),
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(
      (await assignmentRows(tenantA, orderId))[0]?.delivered_at,
    ).toBeNull();
  });
});

// ---- Audit -------------------------------------------------------------------

describe("expo audit trail", () => {
  it("assign and delivered each write an audit row on the order with the acting user", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const at = new Date();
    expect(await auditRows(tenantA, orderId, "%")).toEqual([]);

    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      at,
    );
    const assigned = await auditRows(tenantA, orderId, "%assign%");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.event.actorId).toBe(operator.userId);
    expect(assigned[0]?.event.outletId).toBe(outlet);
    expect(JSON.stringify(assigned[0]?.event)).toContain(runner1.userId);

    await markExpoOrderDelivered(
      ctxA(),
      actorOf(runner1),
      outlet,
      orderId,
      new Date(at.getTime() + MINUTE),
    );
    const delivered = await auditRows(tenantA, orderId, "%deliver%");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.event.actorId).toBe(runner1.userId);
    expect(delivered[0]?.event.outletId).toBe(outlet);
    expect(delivered[0]?.event.objectType).toBe("order");
    expect(delivered[0]?.event.objectId).toBe(orderId);
  });

  it("a refused call writes no audit row", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    await expect(
      markExpoOrderDelivered(
        ctxA(),
        actorOf(runner1),
        outlet,
        orderId,
        new Date(),
      ),
    ).rejects.toMatchObject({ code: "EXPO_RUNNER_NOT_ASSIGNED" });
    await expect(
      assignExpoRunner(
        ctxA(),
        actorOf(operator),
        outlet,
        orderId,
        randomUUID(),
        new Date(),
      ),
    ).rejects.toMatchObject({ code: "EXPO_RUNNER_INVALID" });
    expect(await auditRows(tenantA, orderId, "%")).toEqual([]);
  });
});

// ---- Concurrency -------------------------------------------------------------

describe("expo concurrency", () => {
  it("10 parallel assigns with different runners leave one row and one winner", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const crew = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        member(
          tenantA,
          ROLE_STAFF,
          { type: "tenant", id: null },
          `Runner Paralel ${i}`,
        ),
      ),
    );
    const now = new Date();
    const results = await Promise.allSettled(
      crew.map((who) =>
        assignExpoRunner(
          ctxA(),
          actorOf(operator),
          outlet,
          orderId,
          who.userId,
          now,
        ),
      ),
    );

    // Each call either succeeds or fails with a clean HTTP error, never a raw
    // database error (unique violation, deadlock, serialization failure).
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(HttpError);

    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    const winner = rows[0]?.runner_id;
    expect(crew.map((c) => c.userId)).toContain(winner);
    const onBoard = ticketOf(await readExpoBoard(ctxA(), outlet, now), orderId);
    expect(onBoard.runnerId).toBe(winner);
  });

  it("5 parallel delivered calls stamp one deliveredAt and all answer 200", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const assignedAt = new Date();
    await assignExpoRunner(
      ctxA(),
      actorOf(operator),
      outlet,
      orderId,
      runner1.userId,
      assignedAt,
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        markExpoOrderDelivered(
          ctxA(),
          actorOf(runner1),
          outlet,
          orderId,
          new Date(assignedAt.getTime() + (i + 1) * MINUTE),
        ),
      ),
    );
    const stamps = new Set(results.map((t) => t.deliveredAt));
    expect(stamps.size).toBe(1);
    expect([...stamps][0]).not.toBeNull();

    const rows = await assignmentRows(tenantA, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered_at?.toISOString()).toBe([...stamps][0]);
    expect(rows[0]?.delivered_by).toBe(runner1.userId);
    expect(await auditRows(tenantA, orderId, "%deliver%")).toHaveLength(1);
  });
});

// ---- Isolation ---------------------------------------------------------------

describe("expo isolation: tenant and outlet", () => {
  it("another tenant cannot read, list or act on this tenant's outlet", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);

    await expect(
      readExpoBoard(ctxB(), outlet, new Date()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listExpoRunners(ctxB(), outlet, new Date()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      assignExpoRunner(
        ctxB(),
        actorOf(operatorB),
        outlet,
        orderId,
        operatorB.userId,
        new Date(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);

    // Tenant B's own board never carries tenant A's orders.
    const own = await readExpoBoard(ctxB(), outletB1, new Date());
    expect(own.tickets).toEqual([]);
  });

  it("an outlet-limited caller cannot read or act on another outlet", async () => {
    const orderId = await seedReadyOrder(tenantA, outletA1);
    const onlyA2 = contextOf(tenantA.tenantId, [outletA2]);
    await expect(
      readExpoBoard(onlyA2, outletA1, new Date()),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      listExpoRunners(onlyA2, outletA1, new Date()),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      assignExpoRunner(
        onlyA2,
        actorOf(operator),
        outletA1,
        orderId,
        runner1.userId,
        new Date(),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      markExpoOrderDelivered(
        onlyA2,
        actorOf(operator),
        outletA1,
        orderId,
        new Date(),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });
});

// ---- Routes ------------------------------------------------------------------

describe("expo routes: contract, permission and origin", () => {
  it("serves {data} for the board, the runners, assign and delivered", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const http = api(operator, tenantA, outlet);

    const board = await http.board();
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    const parsed = expoBoardSchema.parse(board.body.data);
    expect(parsed.tickets.map((t) => t.orderId)).toEqual([orderId]);

    const runners = await http.runners();
    expect(runners.status, JSON.stringify(runners.body)).toBe(200);
    const list = (runners.body.data as unknown[]).map((r) =>
      expoRunnerSchema.parse(r),
    );
    expect(list.map((r) => r.userId)).toContain(runner1.userId);
    expect(list.map((r) => r.userId)).not.toContain(operatorB.userId);

    const assigned = await http.assign(orderId, { runnerId: runner1.userId });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(expoTicketSchema.parse(assigned.body.data).runnerId).toBe(
      runner1.userId,
    );

    const delivered = await http.delivered(orderId);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const done = expoTicketSchema.parse(delivered.body.data);
    expect(done.deliveredAt).not.toBeNull();
    const rows = await assignmentRows(tenantA, orderId);
    expect(rows[0]?.delivered_by).toBe(operator.userId);

    const repeat = await http.delivered(orderId);
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.deliveredAt).toBe(done.deliveredAt);
  });

  it("maps service errors to HTTP codes", async () => {
    const outlet = await createOutlet(tenantA);
    const cooking = await seedCookingOrder(tenantA, outlet);
    const ready = await seedReadyOrder(tenantA, outlet);
    const http = api(operator, tenantA, outlet);

    const invalid = await http.assign(cooking, { runnerId: randomUUID() });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe("EXPO_RUNNER_INVALID");

    const noRunner = await http.delivered(ready);
    expect(noRunner.status).toBe(409);
    expect(noRunner.body.error.code).toBe("EXPO_RUNNER_NOT_ASSIGNED");

    await http.assign(cooking, { runnerId: runner1.userId });
    const notComplete = await http.delivered(cooking);
    expect(notComplete.status).toBe(409);
    expect(notComplete.body.error.code).toBe("EXPO_ORDER_NOT_COMPLETE");

    await http.assign(ready, { runnerId: runner1.userId });
    await http.delivered(ready);
    const late = await http.assign(ready, { runnerId: runner2.userId });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("EXPO_ORDER_DELIVERED");

    const missing = await http.delivered(createUlid());
    expect(missing.status).toBe(404);
  });

  it("the assign body is strict: an extra key, a missing or malformed runnerId is a validation error (422)", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedCookingOrder(tenantA, outlet);
    const http = api(operator, tenantA, outlet);
    for (const body of [
      { runnerId: runner1.userId, extra: true },
      {},
      { runnerId: "not-a-uuid" },
      { runnerId: 7 },
    ]) {
      const response = await http.assign(orderId, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);
  });

  it("a user without kds.expo.operate gets 403 on every route and nothing changes", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    const http = api(noAccess, tenantA, outlet);
    expect((await http.board()).status).toBe(403);
    expect((await http.runners()).status).toBe(403);
    expect(
      (await http.assign(orderId, { runnerId: runner1.userId })).status,
    ).toBe(403);
    expect((await http.delivered(orderId)).status).toBe(403);
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);
  });

  it("an anonymous caller gets 401 on every route", async () => {
    const http = api(null, tenantA, outletA1);
    const orderId = createUlid();
    expect((await http.board()).status).toBe(401);
    expect((await http.runners()).status).toBe(401);
    expect(
      (await http.assign(orderId, { runnerId: runner1.userId })).status,
    ).toBe(401);
    expect((await http.delivered(orderId)).status).toBe(401);
  });

  it("a mutation from an untrusted or missing origin is 403 and changes nothing", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    for (const headers of [
      { Origin: "https://evil.example" },
      {} as Record<string, string>,
    ]) {
      const http = api(operator, tenantA, outlet, headers);
      const assigned = await http.assign(orderId, {
        runnerId: runner1.userId,
      });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(403);
      expect(assigned.body.error.code).toBe("FORBIDDEN_ORIGIN");
      expect((await http.delivered(orderId)).status).toBe(403);
    }
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);
  });

  it("an operator limited to outlet A1 gets 403 for outlet A2 but may use A1", async () => {
    const orderA2 = await seedReadyOrder(tenantA, outletA2);
    const http = api(operatorA1, tenantA, outletA2);
    expect((await http.board()).status).toBe(403);
    expect((await http.runners()).status).toBe(403);
    expect(
      (await http.assign(orderA2, { runnerId: runner1.userId })).status,
    ).toBe(403);
    expect((await http.delivered(orderA2)).status).toBe(403);
    expect(await assignmentRows(tenantA, orderA2)).toEqual([]);

    expect((await api(operatorA1, tenantA, outletA1).board()).status).toBe(200);
    expect((await api(operatorA1, tenantA, outletA1).runners()).status).toBe(
      200,
    );
  });

  it("another tenant's operator cannot read or act on this tenant's outlet", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedReadyOrder(tenantA, outlet);
    for (const http of [
      api(operatorB, tenantB, outlet),
      api(operatorB, tenantA, outlet),
    ])
      for (const response of [
        await http.board(),
        await http.runners(),
        await http.assign(orderId, { runnerId: operatorB.userId }),
        await http.delivered(orderId),
      ])
        expect([403, 404], JSON.stringify(response.body)).toContain(
          response.status,
        );
    expect(await assignmentRows(tenantA, orderId)).toEqual([]);

    const own = await api(operatorB, tenantB, outletB1).board();
    expect(own.status).toBe(200);
    expect(own.body.data.tickets).toEqual([]);
    const ownRunners = await api(operatorB, tenantB, outletB1).runners();
    expect(ownRunners.status).toBe(200);
    expect(
      (ownRunners.body.data as { userId: string }[]).map((r) => r.userId),
    ).toEqual([operatorB.userId]);
  });
});
