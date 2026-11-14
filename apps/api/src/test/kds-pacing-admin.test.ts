// Menu load admin and manual channel pause (bead legend-7svpq; PRD v1.7 §3 F12
// "Order Pacing", KDS-05). Contract: @starter/shared/kitchen `listMenuLoads`,
// `setMenuLoads`, `deleteMenuLoad`, `listChannelPauses`, `setManualChannelPause`,
// `releaseManualChannelPause`.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in two fresh
// isolated tenants. Written against the brief and the contract, never against
// the service or the routes.
//
// Assumptions where the brief is silent (also reported):
// - The routes use the real clock, so every `pausedUntil` is relative to
//   `Date.now()` and the pacing helpers are called with `new Date()` (or a
//   shifted date) instead of a fixed instant.
// - A past `pausedUntil` answers 400 or 422 (both are accepted).
// - An unknown or foreign menu item in PUT /menu-loads answers 404 or 422
//   (the brief fixes only 404 for the pause route).
// - Audit rows carry `action`, `objectId` (the row id) and `actorId` inside the
//   `event` JSON of `audit_logs`; before/after values are checked by a
//   substring of the serialized event, not by their exact nesting.
// - `kds.ticket.process` alone (a cook) is refused with 403 on all six routes.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  channelPauseSchema,
  deleteMenuLoad,
  listChannelPauses,
  listMenuLoads,
  menuLoadSchema,
  releaseManualChannelPause,
  setManualChannelPause,
  setMenuLoads,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { LONG_PREP_SECONDS } from "../services/kds-pacing-core.ts";
import {
  evaluatePacing,
  isLinePaused,
  readPausedMenuLines,
} from "../services/kds-pacing.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { tenantContext } from "./tenant-isolation-harness.ts";

const short = () => randomUUID().slice(0, 6);
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const ids = {
  manageRole: randomUUID(),
  cookRole: randomUUID(),
  manageRoleB: randomUUID(),
  outletB: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let ctx: ScopedTenantContext;
let outletA: OutletId;
let headers: { Host: string };
let headersB: { Host: string };
let manager: Member; // kds.station.manage, tenant scope
let outletBManager: Member; // kds.station.manage on outlet B only
let cook: Member; // kds.ticket.process only
let tenantBManager: Member; // kds.station.manage in the other tenant

// ---- fixtures ---------------------------------------------------------------------

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

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

/** A menu item of one tenant (brand-level; no load until the admin sets one). */
async function item(
  forTenant: IsolatedTenant,
  o: { stationId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const category = randomUUID();
  await asOwnerTenant(forTenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 0)`,
      [category, forTenant.tenantId, forTenant.brandId, `Kategori ${short()}`],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, NULL)`,
      [
        id,
        forTenant.tenantId,
        forTenant.brandId,
        category,
        `Menu ${short()}`,
        randomUUID(),
        o.stationId ?? null,
      ],
    );
  });
  return id;
}

async function variant(
  forTenant: IsolatedTenant,
  menuItemId: string,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO item_variants (id, tenant_id, menu_item_id, name) VALUES ($1, $2, $3, $4)`,
      [id, forTenant.tenantId, menuItemId, `Varian ${short()}`],
    );
  });
  return id;
}

type Schedule = { daysOfWeek: number[]; start: string; end: string }[];

function clockHm(date: Date, timeZone = "Asia/Jakarta"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("hour")}:${get("minute")}`;
}

/** A schedule that contains the real clock (three hours either side, split at midnight). */
function scheduleAroundNow(): Schedule {
  const now = Date.now();
  const start = clockHm(new Date(now - 3 * HOUR));
  const end = clockHm(new Date(now + 3 * HOUR));
  if (start < end) return [{ daysOfWeek: ALL_DAYS, start, end }];
  return [
    { daysOfWeek: ALL_DAYS, start, end: "23:59" },
    { daysOfWeek: ALL_DAYS, start: "00:00", end },
  ];
}

/** A station with one rule: 10 points per 10 minutes, dine_in served before gofood. */
async function saturableStation(): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type, target_seconds)
       VALUES ($1, $2, $3, $4, 'hot_kitchen', 300)`,
      [id, tenant.tenantId, tenant.outletId, `Dapur ${short()}`],
    );
    await client.query(
      `INSERT INTO kitchen_capacity_rules
         (tenant_id, outlet_id, station_id, window_minutes, capacity_points,
          near_capacity_bp, schedule, channel_priority)
       VALUES ($1, $2, $3, 10, 10, 8000, $4::jsonb, $5::jsonb)`,
      [
        tenant.tenantId,
        tenant.outletId,
        id,
        JSON.stringify(scheduleAroundNow()),
        JSON.stringify(["dine_in", "gofood"]),
      ],
    );
  });
  return id;
}

/** One open ticket with one line of `itemId` on a station; returns the ticket id. */
async function openTicket(stationId: string, itemId: string): Promise<string> {
  const tenantId = tenant.tenantId;
  const outletId = tenant.outletId;
  const firedAt = new Date(Date.now() - 60_000);
  const orderId = randomUUID();
  const ticketId = randomUUID();
  const orderItemId = randomUUID();
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 10000, 0, 0, 0, 0, 10000,
               'sent', '2026-11-10', $5)`,
      [orderId, tenantId, outletId, `ADM-${randomUUID().slice(0, 8)}`, firedAt],
    );
    await client.query(
      `INSERT INTO kitchen_tickets
         (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no,
          status, priority, fired_at, started_at, done_at, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'),
               'new', 0, $7, NULL, NULL, NULL)`,
      [ticketId, tenantId, outletId, orderId, stationId, randomUUID(), firedAt],
    );
    await client.query(
      `INSERT INTO order_items
         (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name, quantity,
          unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Baris Uji', 1, 10000, 0, 10000, '[]'::jsonb,
               'fired', 'queued', '2026-11-10')`,
      [orderItemId, tenantId, outletId, orderId, itemId],
    );
    await client.query(
      `INSERT INTO kitchen_ticket_items
         (id, tenant_id, outlet_id, ticket_id, order_id, order_item_id, menu_item_id,
          variant_id, name, quantity, status, fired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'Baris Uji', 1, 'queued', $8)`,
      [
        randomUUID(),
        tenantId,
        outletId,
        ticketId,
        orderId,
        orderItemId,
        itemId,
        firedAt,
      ],
    );
  });
  return ticketId;
}

async function finishTicket(ticketId: string) {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE kitchen_tickets
          SET status = 'done', started_at = COALESCE(started_at, fired_at), done_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, ticketId],
    );
  });
}

// ---- HTTP + DB readers ------------------------------------------------------------

function api(
  who: Member | null,
  forHeaders: { Host: string } = headers,
  outletId: string = tenant.outletId,
) {
  const client = who?.client ?? agent(app);
  const base = `/api/outlets/${outletId}/kitchen`;
  const send = (req: ReturnType<typeof client.get>) =>
    req.set(forHeaders).set(originHeader);
  return {
    listLoads: () => send(client.get(`${base}/menu-loads`)),
    putLoads: (body: unknown) =>
      send(client.put(`${base}/menu-loads`)).send(body as object),
    deleteLoad: (loadId: string) =>
      send(client.delete(`${base}/menu-loads/${loadId}`)),
    listPauses: () => send(client.get(`${base}/channel-pauses`)),
    putPause: (body: unknown) =>
      send(client.put(`${base}/channel-pauses`)).send(body as object),
    releasePause: (pauseId: string) =>
      send(client.delete(`${base}/channel-pauses/${pauseId}`)),
  };
}

type LoadInput = {
  menuItemId: string;
  variantId: string | null;
  loadPoints: number;
  prepSeconds: number;
};

const load = (
  menuItemId: string,
  loadPoints = 3,
  prepSeconds = 900,
  variantId: string | null = null,
): LoadInput => ({ menuItemId, variantId, loadPoints, prepSeconds });

async function setLoads(inputs: LoadInput[], who: Member = manager) {
  const res = await api(who).putLoads({ loads: inputs });
  expect(res.status).toBe(200);
  return setMenuLoads.response.parse(res.body).data;
}

async function loadOf(menuItemId: string, variantId: string | null = null) {
  const res = await api(manager).listLoads();
  expect(res.status).toBe(200);
  return listMenuLoads.response
    .parse(res.body)
    .data.find((r) => r.menuItemId === menuItemId && r.variantId === variantId);
}

type PausePut = {
  menuItemId: string;
  variantId?: string | null;
  channels?: string[];
  pausedUntil?: string | null;
};

const pauseBody = (p: PausePut) => ({
  menuItemId: p.menuItemId,
  variantId: p.variantId ?? null,
  channels: p.channels ?? ["gofood"],
  pausedUntil: p.pausedUntil === undefined ? iso(HOUR) : p.pausedUntil,
});

async function pause(p: PausePut, who: Member = manager) {
  const res = await api(who).putPause(pauseBody(p));
  expect(res.status).toBe(200);
  return setManualChannelPause.response.parse(res.body).data;
}

type PauseRow = {
  id: string;
  menu_item_id: string;
  variant_id: string | null;
  station_id: string | null;
  channels: string[];
  reason: string;
  paused_until: Date | null;
  released_at: Date | null;
  created_by: string | null;
};

async function pauseRows(
  menuItemId: string,
  variantId: string | null = null,
): Promise<PauseRow[]> {
  const { rows } = await owner.query<PauseRow>(
    `SELECT id::text, menu_item_id::text, variant_id::text, station_id::text, channels,
            reason, paused_until, released_at, created_by::text
       FROM kitchen_channel_pauses
      WHERE tenant_id = $1 AND menu_item_id = $2 AND variant_id IS NOT DISTINCT FROM $3
      ORDER BY created_at, id`,
    [tenant.tenantId, menuItemId, variantId],
  );
  return rows;
}

const liveManual = (rows: PauseRow[]) =>
  rows.filter((r) => r.reason === "manual" && r.released_at === null);

async function storedLoadCount(menuItemId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM kitchen_menu_loads
      WHERE tenant_id = $1 AND menu_item_id = $2`,
    [tenant.tenantId, menuItemId],
  );
  return Number(rows[0]!.n);
}

async function auditEvents(action: string, objectId: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenant.tenantId, action, objectId],
  );
  return rows.map((row) => row.event);
}

const gofoodLines = (now: Date = new Date()) =>
  withTenant(db, ctx, (tx) =>
    readPausedMenuLines(tx, ctx, outletA, "gofood", now),
  );

const dineInLines = (now: Date = new Date()) =>
  withTenant(db, ctx, (tx) =>
    readPausedMenuLines(tx, ctx, outletA, "dine_in", now),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`adm-${short()}`);
  tenantB = await createIsolatedTenant(`admb-${short()}`);
  ctx = tenantContext(tenant.tenantId);
  outletA = outletIdSchema.parse(tenant.outletId);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.manageRole,
    "Pengelola Dapur",
    ["kds.station.manage"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenant.tenantId,
    ids.cookRole,
    "Koki Saja",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.manageRoleB,
    "Pengelola Dapur B",
    ["kds.station.manage"],
    ["tenant"],
  );

  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Admin B', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $3 AND id = $4`,
    [
      ids.outletB,
      `AB-${short()}`.toUpperCase(),
      tenant.tenantId,
      tenant.outletId,
    ],
  );

  manager = await member(
    tenant,
    ids.manageRole,
    { type: "tenant", id: null },
    "Pengelola Muat",
  );
  outletBManager = await member(
    tenant,
    ids.manageRole,
    { type: "outlet", id: ids.outletB },
    "Pengelola Outlet B",
  );
  cook = await member(
    tenant,
    ids.cookRole,
    { type: "tenant", id: null },
    "Koki Muat",
  );
  tenantBManager = await member(
    tenantB,
    ids.manageRoleB,
    { type: "tenant", id: null },
    "Pengelola Tenant B",
  );
});

// ---- contract ---------------------------------------------------------------------

describe("contract", () => {
  it("serves the contract paths", () => {
    const base = "/api/outlets/:outletId/kitchen";
    expect(listMenuLoads.path).toBe(`${base}/menu-loads`);
    expect(setMenuLoads.path).toBe(`${base}/menu-loads`);
    expect(deleteMenuLoad.path).toBe(`${base}/menu-loads/:loadId`);
    expect(listChannelPauses.path).toBe(`${base}/channel-pauses`);
    expect(setManualChannelPause.path).toBe(`${base}/channel-pauses`);
    expect(releaseManualChannelPause.path).toBe(
      `${base}/channel-pauses/:pauseId`,
    );
  });
});

// ---- menu loads -------------------------------------------------------------------

describe("menu loads CRUD", () => {
  it("KDS-05 an outlet without loads lists an empty array", async () => {
    const res = await api(manager, headers, ids.outletB).listLoads();
    expect(res.status).toBe(200);
    expect(listMenuLoads.response.parse(res.body).data).toEqual([]);
  });

  it("KDS-05 creates item-level and variant loads and lists them with the contract shape", async () => {
    const mie = await item(tenant);
    const pedas = await variant(tenant, mie);
    const stored = await setLoads([
      load(mie, 3, 900),
      load(mie, 5, 1200, pedas),
    ]);
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(menuLoadSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        menuItemId: mie,
      });
    }
    expect(await loadOf(mie)).toMatchObject({
      variantId: null,
      loadPoints: 3,
      prepSeconds: 900,
    });
    expect(await loadOf(mie, pedas)).toMatchObject({
      loadPoints: 5,
      prepSeconds: 1200,
    });
    expect(await storedLoadCount(mie)).toBe(2);
  });

  it("KDS-05 changes the values of an existing line and keeps its id", async () => {
    const nasi = await item(tenant);
    const [created] = await setLoads([load(nasi, 3, 900)]);
    const [changed] = await setLoads([load(nasi, 7, 600)]);
    expect(changed).toMatchObject({
      id: created!.id,
      loadPoints: 7,
      prepSeconds: 600,
    });
    expect(await storedLoadCount(nasi)).toBe(1);
    expect(await loadOf(nasi)).toMatchObject({
      id: created!.id,
      loadPoints: 7,
      prepSeconds: 600,
    });
  });

  it("KDS-05 the same values again change nothing and write no second audit row", async () => {
    const sate = await item(tenant);
    const [created] = await setLoads([load(sate, 2, 300)]);
    expect(
      await auditEvents("kitchen_menu_load.set", created!.id),
    ).toHaveLength(1);

    const [again] = await setLoads([load(sate, 2, 300)]);
    expect(again).toEqual(created);
    expect(
      await auditEvents("kitchen_menu_load.set", created!.id),
    ).toHaveLength(1);
    expect(await storedLoadCount(sate)).toBe(1);

    // A batch mixing an unchanged line and a changed one audits only the change.
    const soto = await item(tenant);
    await setLoads([load(sate, 2, 300), load(soto, 4, 450)]);
    expect(
      await auditEvents("kitchen_menu_load.set", created!.id),
    ).toHaveLength(1);
    const sotoLoad = await loadOf(soto);
    expect(
      await auditEvents("kitchen_menu_load.set", sotoLoad!.id),
    ).toHaveLength(1);
  });

  it("KDS-05 writes an audit row for a new line and one for each change, with before and after", async () => {
    const bakso = await item(tenant);
    const [created] = await setLoads([load(bakso, 3, 900)]);
    const first = await auditEvents("kitchen_menu_load.set", created!.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      action: "kitchen_menu_load.set",
      objectId: created!.id,
      actorId: manager.userId,
    });

    await setLoads([load(bakso, 8, 1500)]);
    const events = await auditEvents("kitchen_menu_load.set", created!.id);
    expect(events).toHaveLength(2);
    const text = JSON.stringify(events);
    for (const value of [
      '"loadPoints":3',
      '"loadPoints":8',
      '"prepSeconds":1500',
    ])
      expect(text).toContain(value);
  });

  it("KDS-05 deletes a line, answers removed:false the second time, and audits only the real removal", async () => {
    const rawon = await item(tenant);
    const [created] = await setLoads([load(rawon, 3, 900)]);

    const first = await api(manager).deleteLoad(created!.id);
    expect(first.status).toBe(200);
    expect(deleteMenuLoad.response.parse(first.body).data).toEqual({
      id: created!.id,
      removed: true,
    });
    expect(await loadOf(rawon)).toBeUndefined();
    expect(await storedLoadCount(rawon)).toBe(0);

    const second = await api(manager).deleteLoad(created!.id);
    expect(second.status).toBe(200);
    expect(deleteMenuLoad.response.parse(second.body).data).toEqual({
      id: created!.id,
      removed: false,
    });

    const audit = await auditEvents("kitchen_menu_load.deleted", created!.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: manager.userId });

    // A random id that never existed is the same answer.
    const unknown = randomUUID();
    const res = await api(manager).deleteLoad(unknown);
    expect(res.status).toBe(200);
    expect(deleteMenuLoad.response.parse(res.body).data).toEqual({
      id: unknown,
      removed: false,
    });
    expect(await auditEvents("kitchen_menu_load.deleted", unknown)).toEqual([]);
  });

  it("KDS-05 a deleted line can be created again", async () => {
    const gado = await item(tenant);
    const [created] = await setLoads([load(gado, 2, 200)]);
    await api(manager).deleteLoad(created!.id);
    const [again] = await setLoads([load(gado, 2, 200)]);
    expect(again!.menuItemId).toBe(gado);
    expect(await storedLoadCount(gado)).toBe(1);
  });

  it("KDS-05 refuses an unknown item and a foreign tenant's item and stores nothing of the batch", async () => {
    const valid = await item(tenant);
    const foreign = await item(tenantB);
    for (const menuItemId of [randomUUID(), foreign]) {
      const res = await api(manager).putLoads({
        loads: [load(valid, 2, 100), load(menuItemId, 2, 100)],
      });
      expect([404, 422]).toContain(res.status);
      expect(await storedLoadCount(valid)).toBe(0);
    }
    expect(await storedLoadCount(foreign)).toBe(0);
  });

  describe("body validation (strict)", () => {
    const bad: [string, (menuItemId: string) => unknown][] = [
      ["an empty list", () => ({ loads: [] })],
      ["a missing list", () => ({})],
      ["an unknown key on the body", (m) => ({ loads: [load(m)], extra: 1 })],
      [
        "a tenant id on a line",
        (m) => ({ loads: [{ ...load(m), tenantId: randomUUID() }] }),
      ],
      ["zero points", (m) => ({ loads: [load(m, 0, 60)] })],
      ["above 100 points", (m) => ({ loads: [load(m, 101, 60)] })],
      ["fractional points", (m) => ({ loads: [load(m, 1.5, 60)] })],
      ["zero seconds", (m) => ({ loads: [load(m, 1, 0)] })],
      ["above 7200 seconds", (m) => ({ loads: [load(m, 1, 7201)] })],
    ];
    it.each(bad)("KDS-05 rejects %s with 422", async (_label, body) => {
      const menuItemId = await item(tenant);
      const res = await api(manager).putLoads(body(menuItemId));
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(await storedLoadCount(menuItemId)).toBe(0);
    });
  });
});

// ---- manual channel pauses --------------------------------------------------------

describe("manual channel pause", () => {
  it("KDS-05 no pauses lists an empty array", async () => {
    const res = await api(manager, headers, ids.outletB).listPauses();
    expect(res.status).toBe(200);
    expect(listChannelPauses.response.parse(res.body).data).toEqual([]);
  });

  it("KDS-05 pauses a menu line: manual reason, no station, created by the actor, listed", async () => {
    const rendang = await item(tenant);
    const until = iso(2 * HOUR);
    const created = await pause({
      menuItemId: rendang,
      channels: ["gofood", "grabfood"],
      pausedUntil: until,
    });
    expect(channelPauseSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      menuItemId: rendang,
      variantId: null,
      reason: "manual",
      createdBy: manager.userId,
    });
    expect([...created.channels].sort()).toEqual(["gofood", "grabfood"]);
    expect(new Date(created.pausedUntil!).getTime()).toBe(
      new Date(until).getTime(),
    );

    const rows = await pauseRows(rendang);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      reason: "manual",
      station_id: null,
      released_at: null,
    });

    const listed = listChannelPauses.response.parse(
      (await api(manager).listPauses()).body,
    ).data;
    expect(listed.find((p) => p.id === created.id)).toEqual(created);
  });

  it("KDS-05 a pause without end time lasts until released", async () => {
    const soto = await item(tenant);
    const created = await pause({
      menuItemId: soto,
      channels: ["dine_in"],
      pausedUntil: null,
    });
    expect(created.pausedUntil).toBeNull();
    expect((await dineInLines()).has(`${soto}:`)).toBe(true);
  });

  it("KDS-05 pausing the same line again updates the one live pause instead of stacking", async () => {
    const mie = await item(tenant);
    const first = await pause({
      menuItemId: mie,
      channels: ["gofood"],
      pausedUntil: iso(HOUR),
    });
    const newUntil = iso(3 * HOUR);
    const second = await pause({
      menuItemId: mie,
      channels: ["gofood", "grabfood"],
      pausedUntil: newUntil,
    });
    expect(second.id).toBe(first.id);
    expect([...second.channels].sort()).toEqual(["gofood", "grabfood"]);
    expect(new Date(second.pausedUntil!).getTime()).toBe(
      new Date(newUntil).getTime(),
    );
    const rows = liveManual(await pauseRows(mie));
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.channels].sort()).toEqual(["gofood", "grabfood"]);
  });

  it("KDS-05 audits each real pause change and skips an identical repeat", async () => {
    const pecel = await item(tenant);
    const until = iso(HOUR);
    const first = await pause({
      menuItemId: pecel,
      channels: ["gofood"],
      pausedUntil: until,
    });
    const audit = () => auditEvents("kitchen_channel_pause.paused", first.id);
    expect(await audit()).toHaveLength(1);
    expect((await audit())[0]).toMatchObject({
      objectId: first.id,
      actorId: manager.userId,
    });

    await pause({
      menuItemId: pecel,
      channels: ["gofood"],
      pausedUntil: until,
    });
    expect(await audit()).toHaveLength(1);

    await pause({
      menuItemId: pecel,
      channels: ["gofood", "dine_in"],
      pausedUntil: until,
    });
    expect(await audit()).toHaveLength(2);
  });

  it("KDS-05 a variant has its own pause, separate from the plain item", async () => {
    const teh = await item(tenant);
    const manis = await variant(tenant, teh);
    const tawar = await variant(tenant, teh);
    const itemPause = await pause({ menuItemId: teh, channels: ["gofood"] });
    const variantPause = await pause({
      menuItemId: teh,
      variantId: manis,
      channels: ["dine_in"],
    });
    expect(variantPause.id).not.toBe(itemPause.id);
    expect(variantPause.variantId).toBe(manis);

    // A variant-level pause pauses only that variant (dine_in carries it).
    const dineIn = await dineInLines();
    expect(isLinePaused(dineIn, teh, manis)).toBe(true);
    expect(isLinePaused(dineIn, teh, tawar)).toBe(false);
    expect(isLinePaused(dineIn, teh, null)).toBe(false);
    // An item-level pause pauses the plain item and every variant (gofood).
    const gofood = await gofoodLines();
    expect(isLinePaused(gofood, teh, null)).toBe(true);
    expect(isLinePaused(gofood, teh, tawar)).toBe(true);
  });

  it("KDS-05 releases a manual pause, answers released:false the second time, and audits once", async () => {
    const gudeg = await item(tenant);
    const created = await pause({ menuItemId: gudeg, channels: ["gofood"] });
    expect((await gofoodLines()).has(`${gudeg}:`)).toBe(true);

    const first = await api(manager).releasePause(created.id);
    expect(first.status).toBe(200);
    expect(releaseManualChannelPause.response.parse(first.body).data).toEqual({
      id: created.id,
      released: true,
    });
    const [row] = await pauseRows(gudeg);
    expect(row!.released_at).not.toBeNull();
    expect((await gofoodLines()).has(`${gudeg}:`)).toBe(false);
    const listed = listChannelPauses.response.parse(
      (await api(manager).listPauses()).body,
    ).data;
    expect(listed.find((p) => p.id === created.id)).toBeUndefined();

    const second = await api(manager).releasePause(created.id);
    expect(second.status).toBe(200);
    expect(releaseManualChannelPause.response.parse(second.body).data).toEqual({
      id: created.id,
      released: false,
    });
    const audit = await auditEvents(
      "kitchen_channel_pause.released",
      created.id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: manager.userId });
  });

  it("KDS-05 releasing a pause whose end time already passed answers released:false and writes no audit", async () => {
    const empal = await item(tenant);
    const created = await pause({
      menuItemId: empal,
      channels: ["gofood"],
      pausedUntil: iso(HOUR),
    });
    // The pause lapses by itself: move its end time into the past (released_at stays null).
    await owner.query(
      `UPDATE kitchen_channel_pauses SET paused_until = now() - interval '1 minute'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, created.id],
    );
    const [lapsed] = await pauseRows(empal);
    expect(lapsed!.released_at).toBeNull();

    const res = await api(manager).releasePause(created.id);
    expect(res.status).toBe(200);
    expect(releaseManualChannelPause.response.parse(res.body).data).toEqual({
      id: created.id,
      released: false,
    });
    expect(
      await auditEvents("kitchen_channel_pause.released", created.id),
    ).toEqual([]);
  });

  it("KDS-05 after a release the line can be paused again with a new pause", async () => {
    const opor = await item(tenant);
    const first = await pause({ menuItemId: opor, channels: ["gofood"] });
    await api(manager).releasePause(first.id);
    const again = await pause({ menuItemId: opor, channels: ["gofood"] });
    expect(again.id).not.toBe(first.id);
    expect(liveManual(await pauseRows(opor))).toHaveLength(1);
  });

  it("KDS-05 a manual pause shows in readPausedMenuLines for its channels only", async () => {
    const ayam = await item(tenant);
    await pause({ menuItemId: ayam, channels: ["gofood"] });
    const gofood = await gofoodLines();
    expect(isLinePaused(gofood, ayam, null)).toBe(true);
    expect(isLinePaused(await dineInLines(), ayam, null)).toBe(false);
  });

  it("KDS-05 a pause past its end time is no longer live", async () => {
    const lele = await item(tenant);
    const open = await item(tenant);
    const created = await pause({
      menuItemId: lele,
      channels: ["gofood"],
      pausedUntil: iso(HOUR),
    });
    await pause({ menuItemId: open, channels: ["gofood"], pausedUntil: null });
    const later = new Date(Date.now() + 2 * HOUR);

    const set = await gofoodLines(later);
    expect(isLinePaused(set, lele, null)).toBe(false);
    expect(isLinePaused(set, open, null)).toBe(true);
    expect(isLinePaused(await gofoodLines(), lele, null)).toBe(true);

    const livePauses = await owner.query<{ id: string }>(
      `SELECT id::text FROM kitchen_channel_pauses
        WHERE tenant_id = $1 AND id = $2
          AND released_at IS NULL AND (paused_until IS NULL OR paused_until > $3)`,
      [tenant.tenantId, created.id, later],
    );
    expect(livePauses.rows).toEqual([]);
  });

  describe("validation", () => {
    it("KDS-05 refuses an end time in the past and stores nothing", async () => {
      const kari = await item(tenant);
      const res = await api(manager).putPause(
        pauseBody({ menuItemId: kari, pausedUntil: iso(-HOUR) }),
      );
      expect([400, 422]).toContain(res.status);
      expect(await pauseRows(kari)).toEqual([]);
      expect(
        await auditEventsFor("kitchen_channel_pause.paused"),
      ).not.toContain(kari);
    });

    it("KDS-05 refuses an unknown item, a foreign tenant's item and a variant of another item with 404", async () => {
      const kari = await item(tenant);
      const other = await item(tenant);
      const foreign = await item(tenantB);
      const otherVariant = await variant(tenant, other);
      const cases: PausePut[] = [
        { menuItemId: randomUUID() },
        { menuItemId: foreign },
        { menuItemId: kari, variantId: otherVariant },
        { menuItemId: kari, variantId: randomUUID() },
      ];
      for (const body of cases) {
        const res = await api(manager).putPause(pauseBody(body));
        expect(res.status).toBe(404);
      }
      expect(await pauseRows(kari)).toEqual([]);
      expect(await pauseRows(foreign)).toEqual([]);
    });

    const bad: [string, (menuItemId: string) => unknown][] = [
      [
        "an empty channel list",
        (m) => pauseBody({ menuItemId: m, channels: [] }),
      ],
      [
        "a duplicate channel",
        (m) => pauseBody({ menuItemId: m, channels: ["gofood", "gofood"] }),
      ],
      [
        "an unknown channel",
        (m) => pauseBody({ menuItemId: m, channels: ["telegram"] }),
      ],
      [
        "an unknown key on the body",
        (m) => ({ ...pauseBody({ menuItemId: m }), stationId: randomUUID() }),
      ],
      [
        "a missing item",
        () => ({ variantId: null, channels: ["gofood"], pausedUntil: null }),
      ],
      [
        "a malformed end time",
        (m) => ({ ...pauseBody({ menuItemId: m }), pausedUntil: "besok" }),
      ],
    ];
    it.each(bad)("KDS-05 rejects %s with 422", async (_label, body) => {
      const menuItemId = await item(tenant);
      const res = await api(manager).putPause(body(menuItemId));
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(await pauseRows(menuItemId)).toEqual([]);
    });
  });
});

/** Object ids of every pause audit row of the tenant with `action`. */
async function auditEventsFor(action: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT event->>'objectId' AS id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenant.tenantId, action],
  );
  return rows.map((row) => row.id);
}

// ---- automatic pacing and manual pauses -------------------------------------------

describe("automatic pause never touches a manual pause", () => {
  it("KDS-05 saturating and draining a station leaves manual pauses as they were, and an automatic pause cannot be released by the route", async () => {
    const dapur = await saturableStation();
    const longA = await item(tenant, { stationId: dapur });
    const longB = await item(tenant, { stationId: dapur });
    const plain = await item(tenant, { stationId: dapur });
    const filler = await item(tenant, { stationId: dapur });
    await setLoads([
      load(longA, 1, LONG_PREP_SECONDS),
      load(longB, 1, LONG_PREP_SECONDS),
      load(plain, 1, 60),
      load(filler, 10, 60),
    ]);

    const manualLong = await pause({
      menuItemId: longA,
      channels: ["dine_in"],
      pausedUntil: null,
    });
    const manualPlain = await pause({
      menuItemId: plain,
      channels: ["gofood"],
      pausedUntil: iso(HOUR),
    });
    const manualSnapshot = async () => [
      ...(await pauseRows(longA)).filter((r) => r.reason === "manual"),
      ...(await pauseRows(plain)).filter((r) => r.reason === "manual"),
    ];
    const before = await manualSnapshot();
    expect(before).toHaveLength(2);

    // 10 of 10 points: at capacity, so the long-prep lines pause for gofood.
    const ticketId = await openTicket(dapur, filler);
    await evaluatePacing(ctx, outletA, new Date());

    const autoRows = [
      ...(await pauseRows(longA)),
      ...(await pauseRows(longB)),
    ].filter((r) => r.reason === "station_capacity" && r.released_at === null);
    expect(autoRows.length).toBeGreaterThanOrEqual(2);
    expect(await manualSnapshot()).toEqual(before);

    const listed = listChannelPauses.response.parse(
      (await api(manager).listPauses()).body,
    ).data;
    expect(
      listed.filter((p) => p.reason === "manual").map((p) => p.id),
    ).toEqual(expect.arrayContaining([manualLong.id, manualPlain.id]));
    const autoListed = listed.filter((p) => p.reason === "station_capacity");
    expect(autoListed.map((p) => p.menuItemId)).toEqual(
      expect.arrayContaining([longA, longB]),
    );

    // The route lifts only manual pauses: an automatic one answers 404 and stays live.
    const autoPause = autoListed.find((p) => p.menuItemId === longB)!;
    const refused = await api(manager).releasePause(autoPause.id);
    expect(refused.status).toBe(404);
    const [stillLive] = (await pauseRows(longB)).filter(
      (r) => r.id === autoPause.id,
    );
    expect(stillLive!.released_at).toBeNull();
    expect(
      await auditEvents("kitchen_channel_pause.released", autoPause.id),
    ).toEqual([]);

    // A manual pause on a line that is also auto-paused is its own row.
    const gofoodNow = await gofoodLines();
    expect(isLinePaused(gofoodNow, longB, null)).toBe(true);
    expect(isLinePaused(gofoodNow, plain, null)).toBe(true);
    expect(isLinePaused(await dineInLines(), longA, null)).toBe(true);

    // Drain the queue: the automatic pauses lift, the manual ones stay.
    await finishTicket(ticketId);
    await evaluatePacing(ctx, outletA, new Date());
    expect(await manualSnapshot()).toEqual(before);
    const afterAuto = [
      ...(await pauseRows(longA)),
      ...(await pauseRows(longB)),
    ].filter((r) => r.reason === "station_capacity" && r.released_at === null);
    expect(afterAuto).toEqual([]);

    const gofoodAfter = await gofoodLines();
    expect(isLinePaused(gofoodAfter, longB, null)).toBe(false);
    expect(isLinePaused(gofoodAfter, plain, null)).toBe(true);
    expect(isLinePaused(await dineInLines(), longA, null)).toBe(true);

    // The manual pause is still the admin's to lift.
    const lifted = await api(manager).releasePause(manualLong.id);
    expect(lifted.status).toBe(200);
    expect(
      releaseManualChannelPause.response.parse(lifted.body).data.released,
    ).toBe(true);
  });

  it("KDS-05 releasing an unknown pause id answers 404", async () => {
    const res = await api(manager).releasePause(randomUUID());
    expect(res.status).toBe(404);
  });
});

// ---- authorization and isolation --------------------------------------------------

describe("authorization", () => {
  it("answers 401 without a session on all six routes", async () => {
    const anon = api(null);
    const menuItemId = randomUUID();
    const results = [
      await anon.listLoads(),
      await anon.putLoads({ loads: [load(menuItemId)] }),
      await anon.deleteLoad(randomUUID()),
      await anon.listPauses(),
      await anon.putPause(pauseBody({ menuItemId })),
      await anon.releasePause(randomUUID()),
    ];
    expect(results.map((res) => res.status)).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
  });

  it("answers 403 for a role without kds.station.manage and changes nothing", async () => {
    const dadar = await item(tenant);
    const [created] = await setLoads([load(dadar, 2, 100)]);
    const manual = await pause({ menuItemId: dadar, channels: ["gofood"] });
    const denied = api(cook);

    const results = [
      await denied.listLoads(),
      await denied.putLoads({ loads: [load(dadar, 9, 999)] }),
      await denied.deleteLoad(created!.id),
      await denied.listPauses(),
      await denied.putPause(
        pauseBody({ menuItemId: dadar, channels: ["dine_in"] }),
      ),
      await denied.releasePause(manual.id),
    ];
    expect(results.map((res) => res.status)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    expect(await loadOf(dadar)).toMatchObject({
      loadPoints: 2,
      prepSeconds: 100,
    });
    const [row] = liveManual(await pauseRows(dadar));
    expect([...row!.channels]).toEqual(["gofood"]);
  });

  it("answers 403 for a manager of another outlet", async () => {
    const tahu = await item(tenant);
    const denied = api(outletBManager);
    expect((await denied.listLoads()).status).toBe(403);
    expect((await denied.putLoads({ loads: [load(tahu)] })).status).toBe(403);
    expect((await denied.listPauses()).status).toBe(403);
    expect(
      (await denied.putPause(pauseBody({ menuItemId: tahu }))).status,
    ).toBe(403);
    expect(await storedLoadCount(tahu)).toBe(0);
    expect(await pauseRows(tahu)).toEqual([]);
  });
});

describe("isolation", () => {
  it("KDS-05 another tenant sees nothing, cannot delete a load and cannot release a pause", async () => {
    const tempe = await item(tenant);
    const [created] = await setLoads([load(tempe, 4, 400)]);
    const manual = await pause({ menuItemId: tempe, channels: ["gofood"] });

    const asB = api(tenantBManager, headersB, tenantB.outletId);
    const listedLoads = await asB.listLoads();
    expect(listedLoads.status).toBe(200);
    expect(listMenuLoads.response.parse(listedLoads.body).data).toEqual([]);
    const listedPauses = await asB.listPauses();
    expect(listedPauses.status).toBe(200);
    expect(listChannelPauses.response.parse(listedPauses.body).data).toEqual(
      [],
    );

    const removed = await asB.deleteLoad(created!.id);
    expect(removed.status).toBe(200);
    expect(deleteMenuLoad.response.parse(removed.body).data).toEqual({
      id: created!.id,
      removed: false,
    });
    expect(await loadOf(tempe)).toMatchObject({ id: created!.id });

    const released = await asB.releasePause(manual.id);
    expect(released.status).toBe(404);
    expect(liveManual(await pauseRows(tempe))).toHaveLength(1);

    // Tenant B cannot reach tenant A's outlet by its id either.
    const cross = api(tenantBManager, headersB, tenant.outletId);
    expect([403, 404]).toContain((await cross.listLoads()).status);
    expect([403, 404]).toContain((await cross.listPauses()).status);
  });

  it("KDS-05 another outlet of the same tenant sees nothing and cannot delete a load or release a pause", async () => {
    const lontong = await item(tenant);
    const [created] = await setLoads([load(lontong, 4, 400)]);
    const manual = await pause({ menuItemId: lontong, channels: ["gofood"] });

    const asOutletB = api(manager, headers, ids.outletB);
    const loads = listMenuLoads.response.parse(
      (await asOutletB.listLoads()).body,
    ).data;
    expect(loads).toEqual([]);
    const pauses = listChannelPauses.response.parse(
      (await asOutletB.listPauses()).body,
    ).data;
    expect(pauses).toEqual([]);

    const removed = await asOutletB.deleteLoad(created!.id);
    expect(removed.status).toBe(200);
    expect(deleteMenuLoad.response.parse(removed.body).data.removed).toBe(
      false,
    );
    expect(await loadOf(lontong)).toMatchObject({ id: created!.id });

    expect((await asOutletB.releasePause(manual.id)).status).toBe(404);
    expect(liveManual(await pauseRows(lontong))).toHaveLength(1);
  });
});
