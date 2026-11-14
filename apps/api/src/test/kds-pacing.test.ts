// Order pacing and serving-time estimate (bead legend-gyc; PRD v1.7 §3 F12
// "Order Pacing" and "Estimasi Waktu Saji Real-time", KDS-05, KDS-06).
// Contracts: @starter/shared/kitchen `getPacing`, `estimateServingTime`,
// `capacityLevelFor`, `channelPauseSchema`, `menuLoadSchema`.
//
// Integration: real Express app, Better Auth, RBAC and PostgreSQL with RLS in
// fresh isolated tenants (one world per describe, so queues never mix).
// Written against the sub-brief's design decisions, never against the code.
//
// Assumptions where the brief is silent (also reported):
// - The menu channel of a seeded order follows the POS price channel: a `pos`
//   order is `dine_in` or `takeaway` by its service type, `gofood`/`grabfood`
//   are themselves. `dine_in` = (pos, dine_in), `gofood` = (gofood, delivery).
// - `estimateServingTime` takes its queue-ahead from the channel's priority and
//   service seconds from the station fallback (600 s) when no history/lines.
//   The cart's own load points are not asserted beyond "never lowers the ETA".
// - `service seconds` of a cart estimate use the longest prep of the CART lines.
// - Supervisor alerts are stored as notification_outbox events named
//   `kitchen_pacing.near_capacity` / `kitchen_pacing.at_capacity`.
// - GET /serving-time-estimate is open to a cashier role holding `order.view`
//   and `pos.sale.create`; a role with only `floor.table.view` is refused.
//   (The brief does not name the permission; a cook with only
//   `kds.ticket.process` turned out to be refused, so the tests use a cashier.)
// - Query validation answers 422 VALIDATION_ERROR like every other KDS read in
//   this repo (the brief said 400).
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  capacityLevelFor,
  channelPauseSchema,
  estimateServingTime as estimateServingTimeEndpoint,
  getPacing,
  menuLoadSchema,
  pacingSnapshotSchema,
  servingTimeEstimateSchema,
  type CapacityLevel,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  FALLBACK_SERVICE_SECONDS,
  LONG_PREP_SECONDS,
} from "../services/kds-pacing-core.ts";
import {
  evaluatePacing,
  evaluatePacingIfStale,
  isLinePaused,
  listChannelPauses,
  listMenuLoads,
  readPausedMenuLines,
  readStationHistory,
  readStationQueue,
  setMenuLoads,
} from "../services/kds-pacing.service.ts";
import {
  estimateServingTime,
  installKdsServingEstimate,
  kdsServingEstimatePort,
} from "../services/kds-estimate.service.ts";
import {
  qrOrderServingEstimatePort,
  setQrOrderServingEstimatePort,
} from "../services/qr-order-ports.ts";
import type { Tx } from "../services/menu-internals.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant,
  createAppPool,
  expectRowsIsolated,
  tenantContext,
} from "./tenant-isolation-harness.ts";

const short = () => randomUUID().slice(0, 6);

/** Tue 2026-11-10 12:07:30 in Asia/Jakarta (the outlet time zone). */
const NOW = new Date("2026-11-10T05:07:30.000Z");
const at = (offsetMinutes: number, from: Date = NOW) =>
  new Date(from.getTime() + offsetMinutes * 60_000);
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

type MenuChannel = "dine_in" | "takeaway" | "gofood" | "grabfood";
type Schedule = { daysOfWeek: number[]; start: string; end: string }[];
type RuleSpec = {
  windowMinutes: number;
  capacityPoints: number;
  nearCapacityBp: number;
  schedule: Schedule;
  channelPriority: string[];
};
type TicketStatus = "new" | "in_progress" | "done" | "recalled" | "cancelled";

/** 08:00-22:00 every day: contains NOW (12:07 local). */
const DAY: Schedule = [{ daysOfWeek: ALL_DAYS, start: "08:00", end: "22:00" }];

function rule(patch: Partial<RuleSpec> = {}): RuleSpec {
  return {
    windowMinutes: 15,
    capacityPoints: 30,
    nearCapacityBp: 8000,
    schedule: DAY,
    channelPriority: ["dine_in", "gofood"],
    ...patch,
  };
}

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

/**
 * A schedule that contains the real clock (HTTP tests cannot pass `now`):
 * three hours either side, split at midnight so no overnight rule is needed.
 */
function scheduleAroundNow(): Schedule {
  const now = Date.now();
  const start = clockHm(new Date(now - 3 * 3_600_000));
  const end = clockHm(new Date(now + 3 * 3_600_000));
  if (start < end) return [{ daysOfWeek: ALL_DAYS, start, end }];
  return [
    { daysOfWeek: ALL_DAYS, start, end: "23:59" },
    { daysOfWeek: ALL_DAYS, start: "00:00", end },
  ];
}

// ---- fixtures ---------------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  outletIds = "*",
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outletIds],
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

const oid = (id: string): OutletId => outletIdSchema.parse(id);

type World = {
  tenant: IsolatedTenant;
  ctx: ScopedTenantContext;
  outletId: string;
  outlet: OutletId;
};

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(`pac${label}${short()}`);
  return {
    tenant,
    ctx: tenantContext(tenant.tenantId),
    outletId: tenant.outletId,
    outlet: oid(tenant.outletId),
  };
}

/** A second outlet in the same tenant. */
async function addOutlet(w: World): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Pacing 2', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [id, `PB-${short()}`.toUpperCase(), w.tenant.tenantId, w.outletId],
    );
  });
  return id;
}

async function insertRule(
  client: PoolClient,
  tenantId: string,
  outletId: string,
  stationId: string,
  spec: RuleSpec,
) {
  await client.query(
    `INSERT INTO kitchen_capacity_rules
       (tenant_id, outlet_id, station_id, window_minutes, capacity_points,
        near_capacity_bp, schedule, channel_priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      tenantId,
      outletId,
      stationId,
      spec.windowMinutes,
      spec.capacityPoints,
      spec.nearCapacityBp,
      JSON.stringify(spec.schedule),
      JSON.stringify(spec.channelPriority),
    ],
  );
}

async function station(
  w: World,
  o: {
    outletId?: string;
    name?: string;
    type?: string;
    targetSeconds?: number | null;
    rules?: RuleSpec[];
  } = {},
): Promise<string> {
  const id = randomUUID();
  const outletId = o.outletId ?? w.outletId;
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type, target_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        w.tenant.tenantId,
        outletId,
        o.name ?? `Stasiun ${short()}`,
        o.type ?? "hot_kitchen",
        o.targetSeconds ?? null,
      ],
    );
    for (const spec of o.rules ?? [])
      await insertRule(client, w.tenant.tenantId, outletId, id, spec);
  });
  return id;
}

/**
 * A menu item. `load` writes the item-level (variant NULL) menu load of one
 * outlet; no load means the default (1 point, the station's prep time).
 */
async function item(
  w: World,
  o: {
    name?: string;
    stationId?: string | null;
    /** Brand-level routing (`menu_items.station_type`), used without a stationId. */
    stationType?: string | null;
    load?: { points: number; prep: number; outletId?: string };
  } = {},
): Promise<string> {
  const id = randomUUID();
  const category = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 0)`,
      [category, w.tenant.tenantId, w.tenant.brandId, `Kategori ${short()}`],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
      [
        id,
        w.tenant.tenantId,
        w.tenant.brandId,
        category,
        o.name ?? `Menu ${short()}`,
        randomUUID(),
        o.stationId ?? null,
        o.stationType ?? null,
      ],
    );
    if (o.load)
      await client.query(
        `INSERT INTO kitchen_menu_loads (tenant_id, outlet_id, menu_item_id, variant_id, load_points, prep_seconds)
         VALUES ($1, $2, $3, NULL, $4, $5)`,
        [
          w.tenant.tenantId,
          o.load.outletId ?? w.outletId,
          id,
          o.load.points,
          o.load.prep,
        ],
      );
  });
  return id;
}

async function variant(
  w: World,
  menuItemId: string,
  load?: { points: number; prep: number },
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO item_variants (id, tenant_id, menu_item_id, name) VALUES ($1, $2, $3, $4)`,
      [id, w.tenant.tenantId, menuItemId, `Varian ${short()}`],
    );
    if (load)
      await client.query(
        `INSERT INTO kitchen_menu_loads (tenant_id, outlet_id, menu_item_id, variant_id, load_points, prep_seconds)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [w.tenant.tenantId, w.outletId, menuItemId, id, load.points, load.prep],
      );
  });
  return id;
}

const ORDER_OF: Record<MenuChannel, [string, string]> = {
  dine_in: ["pos", "dine_in"],
  takeaway: ["pos", "takeaway"],
  gofood: ["gofood", "delivery"],
  grabfood: ["grabfood", "delivery"],
};

type Line = { itemId: string; variantId?: string | null; qty?: number };

/** One order with one station ticket and its lines; returns the ticket id. */
async function ticket(
  w: World,
  o: {
    stationId: string;
    lines: Line[];
    channel?: MenuChannel;
    status?: TicketStatus;
    outletId?: string;
    firedAt?: Date;
    startedAt?: Date | null;
    doneAt?: Date | null;
  },
): Promise<string> {
  const tenantId = w.tenant.tenantId;
  const outletId = o.outletId ?? w.outletId;
  const status = o.status ?? "new";
  const firedAt = o.firedAt ?? new Date(Date.now() - 60_000);
  const startedAt =
    o.startedAt !== undefined ? o.startedAt : status === "new" ? null : firedAt;
  const doneAt =
    o.doneAt !== undefined
      ? o.doneAt
      : status === "done" || status === "recalled"
        ? new Date(firedAt.getTime() + 60_000)
        : null;
  const cancelledAt = status === "cancelled" ? firedAt : null;
  const lineStatus =
    status === "in_progress"
      ? "in_progress"
      : status === "done"
        ? "ready"
        : status === "cancelled"
          ? "voided"
          : "queued";
  const [orderChannel, serviceType] = ORDER_OF[o.channel ?? "dine_in"];
  const orderId = randomUUID();
  const ticketId = randomUUID();
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pay_first', 20000, 0, 0, 0, 0, 20000,
               'sent', '2026-11-10', $7)`,
      [
        orderId,
        tenantId,
        outletId,
        `PAC-${randomUUID().slice(0, 8)}`,
        orderChannel,
        serviceType,
        firedAt,
      ],
    );
    await client.query(
      `INSERT INTO kitchen_tickets
         (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no,
          status, priority, fired_at, started_at, done_at, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'),
               $7, 0, $8, $9, $10, $11)`,
      [
        ticketId,
        tenantId,
        outletId,
        orderId,
        o.stationId,
        randomUUID(),
        status,
        firedAt,
        startedAt,
        doneAt,
        cancelledAt,
      ],
    );
    for (const line of o.lines) {
      const qty = line.qty ?? 1;
      const orderItemId = randomUUID();
      await client.query(
        `INSERT INTO order_items
           (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name, quantity,
            unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
            fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'Baris Uji', $7, 10000, 0, $8, '[]'::jsonb,
                 'fired', $9, '2026-11-10')`,
        [
          orderItemId,
          tenantId,
          outletId,
          orderId,
          line.itemId,
          line.variantId ?? null,
          qty,
          10_000 * qty,
          lineStatus,
        ],
      );
      await client.query(
        `INSERT INTO kitchen_ticket_items
           (id, tenant_id, outlet_id, ticket_id, order_id, order_item_id, menu_item_id,
            variant_id, name, quantity, status, fired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Baris Uji', $9, $10, $11)`,
        [
          randomUUID(),
          tenantId,
          outletId,
          ticketId,
          orderId,
          orderItemId,
          line.itemId,
          line.variantId ?? null,
          qty,
          lineStatus,
          firedAt,
        ],
      );
    }
  });
  return ticketId;
}

/** `count` one-point (default load) lines of `itemId` on a new open ticket. */
function lines(itemId: string, count: number): Line[] {
  return Array.from({ length: count }, () => ({ itemId }));
}

async function finishTickets(w: World, ticketIds: string[], doneAt: Date) {
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE kitchen_tickets
          SET status = 'done', started_at = COALESCE(started_at, fired_at), done_at = $3
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [w.tenant.tenantId, ticketIds, doneAt],
    );
  });
}

async function insertPause(
  w: World,
  o: {
    menuItemId: string;
    channels: string[];
    pausedUntil?: Date | null;
    outletId?: string;
    variantId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO kitchen_channel_pauses
         (id, tenant_id, outlet_id, menu_item_id, variant_id, channels, reason, paused_until)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'manual', $7)`,
      [
        id,
        w.tenant.tenantId,
        o.outletId ?? w.outletId,
        o.menuItemId,
        o.variantId ?? null,
        JSON.stringify(o.channels),
        o.pausedUntil ?? null,
      ],
    );
  });
  return id;
}

type PauseRow = {
  id: string;
  menu_item_id: string;
  variant_id: string | null;
  station_id: string | null;
  channels: string[];
  reason: string;
  released_at: Date | null;
};

async function pauseRows(w: World, where = "TRUE"): Promise<PauseRow[]> {
  const { rows } = await owner.query<PauseRow>(
    `SELECT id::text, menu_item_id::text, variant_id::text, station_id::text,
            channels, reason, released_at
       FROM kitchen_channel_pauses
      WHERE tenant_id = $1 AND outlet_id = $2 AND (${where}) ORDER BY created_at, id`,
    [w.tenant.tenantId, w.outletId],
  );
  return rows;
}

const liveAuto = (rows: PauseRow[]) =>
  rows.filter((r) => r.reason === "station_capacity" && r.released_at === null);

const lineKey = (menuItemId: string, variantId: string | null = null) =>
  `${menuItemId}:${variantId ?? ""}`;

async function stateOf(w: World, stationId: string) {
  const { rows } = await owner.query<{
    level: string;
    used_points: number;
    changed_at: Date;
    evaluated_at: Date;
  }>(
    `SELECT level, used_points, changed_at, evaluated_at FROM kitchen_pacing_state
      WHERE tenant_id = $1 AND station_id = $2`,
    [w.tenant.tenantId, stationId],
  );
  return rows[0] ?? null;
}

const stationOf = <S extends { stationId: string }>(
  snapshot: { stations: S[] },
  stationId: string,
): S | undefined =>
  snapshot.stations.find((row) => row.stationId === stationId);

async function pacing(w: World, now: Date) {
  const snapshot = await evaluatePacing(w.ctx, w.outlet, now);
  expect(pacingSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  return snapshot;
}

const inTx = <T>(w: World, run: (tx: Tx) => Promise<T>) =>
  withTenant(db, w.ctx, run);

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
  scopes: string[] = ["tenant", "outlet"],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
  return id;
}

type Member = { client: ReturnType<typeof agent>; userId: string };

async function member(
  app: Express,
  tenantId: string,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
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
    [tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

let app: Express;
let appPool: Pool;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  appPool = createAppPool();
});

afterAll(async () => {
  setQrOrderServingEstimatePort(null);
  await appPool?.end();
  // Rows stay in the disposable database, like the other KDS tests.
});

// ---- isLinePaused (pure helper) ----------------------------------------------------

describe("isLinePaused", () => {
  const a = randomUUID();
  const v1 = randomUUID();
  const v2 = randomUUID();

  it("KDS-05 an item-level pause (no variant) pauses every variant and the plain item", () => {
    const paused = new Set([lineKey(a)]);
    expect(isLinePaused(paused, a, null)).toBe(true);
    expect(isLinePaused(paused, a, v1)).toBe(true);
    expect(isLinePaused(paused, randomUUID(), null)).toBe(false);
  });

  it("KDS-05 a variant pause pauses only that variant", () => {
    const paused = new Set([lineKey(a, v1)]);
    expect(isLinePaused(paused, a, v1)).toBe(true);
    expect(isLinePaused(paused, a, v2)).toBe(false);
    expect(isLinePaused(paused, a, null)).toBe(false);
  });

  it("KDS-05 an empty set pauses nothing", () => {
    expect(isLinePaused(new Set(), a, null)).toBe(false);
    expect(isLinePaused(new Set(), a, v1)).toBe(false);
  });
});

// ---- capacity per slot -------------------------------------------------------------

describe("capacity per slot (KDS-05)", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld("cap");
  });

  type Expected = {
    windowMinutes: number;
    capacityPoints: number;
    nearCapacityBp: number;
    windowStart: string;
  };

  // Each case owns its station, so queues never mix. NOW is Tuesday 12:07 local.
  const cases: {
    label: string;
    now: Date;
    rules: RuleSpec[];
    expected: Expected | null;
  }[] = [
    {
      label: "the rule whose schedule contains the moment (lunch, not dinner)",
      now: new Date("2026-11-10T04:05:00.000Z"), // Tue 11:05
      rules: [
        rule({
          windowMinutes: 15,
          capacityPoints: 20,
          schedule: [
            { daysOfWeek: [1, 2, 3, 4, 5], start: "11:00", end: "14:00" },
          ],
        }),
        rule({
          windowMinutes: 30,
          capacityPoints: 40,
          nearCapacityBp: 5000,
          schedule: [
            { daysOfWeek: [1, 2, 3, 4, 5], start: "17:00", end: "22:00" },
          ],
        }),
      ],
      expected: {
        windowMinutes: 15,
        capacityPoints: 20,
        nearCapacityBp: 8000,
        windowStart: "2026-11-10T04:00:00.000Z",
      },
    },
    {
      label: "the other rule at dinner time",
      now: new Date("2026-11-10T11:00:00.000Z"), // Tue 18:00
      rules: [
        rule({
          windowMinutes: 15,
          capacityPoints: 20,
          schedule: [
            { daysOfWeek: [1, 2, 3, 4, 5], start: "11:00", end: "14:00" },
          ],
        }),
        rule({
          windowMinutes: 30,
          capacityPoints: 40,
          nearCapacityBp: 5000,
          schedule: [
            { daysOfWeek: [1, 2, 3, 4, 5], start: "17:00", end: "22:00" },
          ],
        }),
      ],
      expected: {
        windowMinutes: 30,
        capacityPoints: 40,
        nearCapacityBp: 5000,
        windowStart: "2026-11-10T11:00:00.000Z",
      },
    },
    {
      label: "several rules match: the smallest window wins",
      now: NOW,
      rules: [
        rule({ windowMinutes: 15, capacityPoints: 100 }),
        rule({ windowMinutes: 5, capacityPoints: 7 }),
        rule({ windowMinutes: 30, capacityPoints: 200 }),
      ],
      expected: {
        windowMinutes: 5,
        capacityPoints: 7,
        nearCapacityBp: 8000,
        windowStart: "2026-11-10T05:05:00.000Z",
      },
    },
    {
      label: "same window: the highest capacity wins",
      now: NOW,
      rules: [
        rule({ windowMinutes: 10, capacityPoints: 8 }),
        rule({ windowMinutes: 10, capacityPoints: 9 }),
        rule({ windowMinutes: 10, capacityPoints: 6 }),
      ],
      expected: {
        windowMinutes: 10,
        capacityPoints: 9,
        nearCapacityBp: 8000,
        windowStart: "2026-11-10T05:00:00.000Z",
      },
    },
    {
      label: "an overnight window matches before midnight on a listed day",
      now: new Date("2026-11-13T16:00:00.000Z"), // Fri 23:00
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 12,
          schedule: [{ daysOfWeek: [5], start: "22:00", end: "02:00" }],
        }),
      ],
      expected: {
        windowMinutes: 10,
        capacityPoints: 12,
        nearCapacityBp: 8000,
        windowStart: "2026-11-13T16:00:00.000Z",
      },
    },
    {
      label: "no row outside the scheduled hours",
      now: new Date("2026-11-10T08:00:00.000Z"), // Tue 15:00
      rules: [
        rule({
          schedule: [
            { daysOfWeek: [1, 2, 3, 4, 5], start: "11:00", end: "14:00" },
          ],
        }),
      ],
      expected: null,
    },
    {
      label: "no row on a day that is not scheduled (Saturday)",
      now: new Date("2026-11-14T05:07:30.000Z"), // Sat 12:07
      rules: [
        rule({
          schedule: [
            { daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "22:00" },
          ],
        }),
      ],
      expected: null,
    },
    {
      label:
        "no row on a weekday the overnight rule does not list (Tuesday 23:00)",
      now: new Date("2026-11-10T16:00:00.000Z"), // Tue 23:00
      rules: [
        rule({
          schedule: [{ daysOfWeek: [5], start: "22:00", end: "02:00" }],
        }),
      ],
      expected: null,
    },
  ];

  it.each(cases)("KDS-05 $label", async ({ now, rules, expected }) => {
    const id = await station(w, { rules });
    const snapshot = await pacing(w, now);
    const row = stationOf(snapshot, id);
    if (expected === null) {
      expect(row).toBeUndefined();
      return;
    }
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      tenantId: w.tenant.tenantId,
      outletId: w.outletId,
      stationId: id,
      windowMinutes: expected.windowMinutes,
      capacityPoints: expected.capacityPoints,
      nearCapacityBp: expected.nearCapacityBp,
      usedPoints: 0,
      queuedItems: 0,
      status: "available",
    });
    expect(new Date(row!.windowStart).toISOString()).toBe(expected.windowStart);
  });

  it("KDS-05 a station without any rule has no pacing row, an empty outlet an empty snapshot", async () => {
    const lonely = await makeWorld("capempty");
    const none = await pacing(lonely, NOW);
    expect(none).toMatchObject({
      tenantId: lonely.tenant.tenantId,
      outletId: lonely.outletId,
      stations: [],
    });
    const id = await station(lonely, { rules: [] });
    expect(stationOf(await pacing(lonely, NOW), id)).toBeUndefined();
  });

  it("KDS-05 the snapshot is stamped with the moment it was computed", async () => {
    const id = await station(w, { rules: [rule()] });
    const snapshot = await pacing(w, NOW);
    expect(stationOf(snapshot, id)).toBeDefined();
    expect(new Date(snapshot.generatedAt).getTime()).toBe(NOW.getTime());
  });

  it("KDS-05 used points are the open queue: loadPoints x quantity, new and in_progress only", async () => {
    const id = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    const ayam = await item(w, {
      stationId: id,
      load: { points: 2, prep: 300 },
    });
    const sate = await item(w, { stationId: id }); // default: 1 point
    const mie = await item(w, {
      stationId: id,
      load: { points: 3, prep: 300 },
    });
    const pedas = await variant(w, mie, { points: 5, prep: 300 }); // exact variant row
    const biasa = await variant(w, mie); // no row of its own: item-level 3

    await ticket(w, {
      stationId: id,
      status: "new",
      lines: [
        { itemId: ayam, qty: 2 }, // 4
        { itemId: sate, qty: 3 }, // 3
      ],
    });
    await ticket(w, {
      stationId: id,
      status: "in_progress",
      lines: [
        { itemId: mie, variantId: pedas, qty: 1 }, // 5
        { itemId: mie, variantId: biasa, qty: 2 }, // 6
        { itemId: mie, qty: 1 }, // 3
      ],
    });
    // Not part of the open queue: they must not count.
    for (const status of ["done", "cancelled", "recalled"] as const)
      await ticket(w, {
        stationId: id,
        status,
        lines: [{ itemId: ayam, qty: 5 }],
      });

    const row = stationOf(await pacing(w, NOW), id)!;
    expect(row.usedPoints).toBe(4 + 3 + 5 + 6 + 3);
    expect(row.status).toBe("available");
  });

  it("KDS-05 queuedItems counts the open lines (one unit each here)", async () => {
    const id = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    const kopi = await item(w, { stationId: id });
    await ticket(w, { stationId: id, lines: lines(kopi, 3) });
    await ticket(w, {
      stationId: id,
      status: "in_progress",
      lines: lines(kopi, 2),
    });
    await ticket(w, { stationId: id, status: "done", lines: lines(kopi, 4) });
    const row = stationOf(await pacing(w, NOW), id)!;
    expect(row.usedPoints).toBe(5);
    expect(row.queuedItems).toBe(5);
  });

  it("KDS-05 the queue of one station never counts on another", async () => {
    const busy = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    const quiet = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    const kopi = await item(w, { stationId: busy });
    await ticket(w, { stationId: busy, lines: lines(kopi, 6) });
    const snapshot = await pacing(w, NOW);
    expect(stationOf(snapshot, busy)!.usedPoints).toBe(6);
    expect(stationOf(snapshot, quiet)!.usedPoints).toBe(0);
  });

  it("KDS-05 level follows capacityLevelFor at every boundary (capacity 10, near 80%)", async () => {
    const id = await station(w, {
      rules: [rule({ capacityPoints: 10, nearCapacityBp: 8000 })],
    });
    const kopi = await item(w, { stationId: id });
    const steps: [number, CapacityLevel][] = [
      [0, "available"],
      [7, "available"],
      [8, "near_capacity"],
      [9, "near_capacity"],
      [10, "at_capacity"],
      [14, "at_capacity"],
    ];
    let used = 0;
    for (const [target, expected] of steps) {
      if (target > used) {
        await ticket(w, { stationId: id, lines: lines(kopi, target - used) });
        used = target;
      }
      const row = stationOf(await pacing(w, NOW), id)!;
      expect(row.usedPoints).toBe(target);
      expect(row.status).toBe(expected);
      // The contract helper agrees with what the service answered.
      expect(row.status).toBe(capacityLevelFor(target, 10, 8000));
    }
  });

  it("KDS-05 a custom near-capacity level moves the warning boundary", async () => {
    const id = await station(w, {
      rules: [rule({ capacityPoints: 10, nearCapacityBp: 5000 })],
    });
    const kopi = await item(w, { stationId: id });
    await ticket(w, { stationId: id, lines: lines(kopi, 4) });
    expect(stationOf(await pacing(w, NOW), id)!.status).toBe("available");
    await ticket(w, { stationId: id, lines: lines(kopi, 1) });
    expect(stationOf(await pacing(w, NOW), id)!.status).toBe("near_capacity");
  });

  it("KDS-05 a ticket added between two reads shows on the very next read", async () => {
    const id = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    const kopi = await item(w, { stationId: id });
    expect(stationOf(await pacing(w, NOW), id)!.usedPoints).toBe(0);
    await ticket(w, { stationId: id, lines: lines(kopi, 2) });
    expect(stationOf(await pacing(w, NOW), id)!.usedPoints).toBe(2);
    await ticket(w, { stationId: id, lines: lines(kopi, 3) });
    expect(stationOf(await pacing(w, NOW), id)!.usedPoints).toBe(5);
  });
});

// ---- evaluate on read --------------------------------------------------------------

describe("evaluate on read (KDS-05, 30 s)", () => {
  let w: World;
  let stationId: string;
  let kopi: string;
  beforeAll(async () => {
    w = await makeWorld("stale");
    stationId = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    kopi = await item(w, { stationId });
  });

  it("KDS-05 the first call evaluates and records the state", async () => {
    expect(await stateOf(w, stationId)).toBeNull();
    await ticket(w, { stationId, lines: lines(kopi, 2) });
    await evaluatePacingIfStale(w.ctx, w.outlet, NOW);
    const state = await stateOf(w, stationId);
    expect(state).toMatchObject({ level: "available", used_points: 2 });
    expect(state!.evaluated_at.getTime()).toBe(NOW.getTime());
  });

  it("KDS-05 a fresh state (younger than 10 s) is not recomputed", async () => {
    await ticket(w, { stationId, lines: lines(kopi, 3) });
    await evaluatePacingIfStale(
      w.ctx,
      w.outlet,
      new Date(NOW.getTime() + 5_000),
    );
    const state = await stateOf(w, stationId);
    expect(state!.used_points).toBe(2);
    expect(state!.evaluated_at.getTime()).toBe(NOW.getTime());
  });

  it("KDS-05 a state older than 10 s is recomputed", async () => {
    const later = new Date(NOW.getTime() + 11_000);
    await evaluatePacingIfStale(w.ctx, w.outlet, later);
    const state = await stateOf(w, stationId);
    expect(state!.used_points).toBe(5);
    expect(state!.evaluated_at.getTime()).toBe(later.getTime());
  });

  it("KDS-05 a custom max age is honoured", async () => {
    await ticket(w, { stationId, lines: lines(kopi, 1) });
    const base = new Date(NOW.getTime() + 11_000);
    await evaluatePacingIfStale(
      w.ctx,
      w.outlet,
      new Date(base.getTime() + 2_000),
      5_000,
    );
    expect((await stateOf(w, stationId))!.used_points).toBe(5);
    const later = new Date(base.getTime() + 2_000);
    await evaluatePacingIfStale(
      w.ctx,
      w.outlet,
      new Date(later.getTime() + 2_000),
      1_000,
    );
    expect((await stateOf(w, stationId))!.used_points).toBe(6);
  });

  it("KDS-05 evaluatePacingIfStale refreshes a stale state; readPausedMenuLines alone is a plain read and never evaluates", async () => {
    const f = await makeWorld("readpaused");
    const dapur = await station(f, {
      targetSeconds: 300,
      rules: [rule({ capacityPoints: 4, windowMinutes: 10 })],
    });
    const rendang = await item(f, {
      stationId: dapur,
      load: { points: 3, prep: 1200 },
    });
    const esteh = await item(f, { stationId: dapur });
    // A full station (3 + 1 of 4 points) that nobody has evaluated yet.
    await ticket(f, {
      stationId: dapur,
      lines: [{ itemId: rendang }, { itemId: esteh }],
    });
    const pausedFor = (now: Date) =>
      inTx(f, (tx) => readPausedMenuLines(tx, f.ctx, f.outlet, "gofood", now));

    // The plain read sees no pause and writes nothing: no state, no pause row.
    expect((await pausedFor(NOW)).size).toBe(0);
    expect(await stateOf(f, dapur)).toBeNull();
    expect(await pauseRows(f)).toEqual([]);

    // The evaluator notices the full station and records the pause.
    await evaluatePacingIfStale(f.ctx, f.outlet, NOW);
    expect((await stateOf(f, dapur))!.evaluated_at.getTime()).toBe(
      NOW.getTime(),
    );
    const first = await pausedFor(NOW);
    expect(first.has(lineKey(rendang))).toBe(true);
    expect(first.has(lineKey(esteh))).toBe(false);

    // The queue drains. A plain read after the max age still shows the old
    // pause and leaves the stored state alone ...
    const tickets = await owner.query<{ id: string }>(
      "SELECT id::text FROM kitchen_tickets WHERE tenant_id = $1",
      [f.tenant.tenantId],
    );
    await finishTickets(
      f,
      tickets.rows.map((r) => r.id),
      NOW,
    );
    const later = new Date(NOW.getTime() + 11_000);
    expect((await pausedFor(later)).has(lineKey(rendang))).toBe(true);
    expect((await stateOf(f, dapur))!.evaluated_at.getTime()).toBe(
      NOW.getTime(),
    );
    // ... until the evaluator runs: it lifts the pause and stamps the state.
    await evaluatePacingIfStale(f.ctx, f.outlet, later);
    expect((await pausedFor(later)).size).toBe(0);
    expect((await stateOf(f, dapur))!.evaluated_at.getTime()).toBe(
      later.getTime(),
    );
  });
});

// ---- ETA ---------------------------------------------------------------------------

describe("serving time estimate (F12, KDS-06)", () => {
  describe("queue and channel priority", () => {
    let w: World;
    let dapur: string;
    let nasi: string;
    beforeAll(async () => {
      w = await makeWorld("eta");
      // 30 points per 15 min = 2 points per minute; default prep 600 s.
      dapur = await station(w, {
        rules: [rule({ windowMinutes: 15, capacityPoints: 30 })],
      });
      nasi = await item(w, { stationId: dapur });
    });

    const eta = async (channel: MenuChannel, loadPoints = 0, now = NOW) => {
      const result = await estimateServingTime(
        w.ctx,
        w.outlet,
        { channel, loadPoints },
        now,
      );
      expect(servingTimeEstimateSchema.parse(result)).toEqual(result);
      expect(result.channel).toBe(channel);
      expect(result).toMatchObject({
        tenantId: w.tenant.tenantId,
        outletId: w.outletId,
      });
      expect(new Date(result.computedAt).getTime()).toBe(now.getTime());
      // Ready-at is computed from the same minutes the caller is shown.
      expect(new Date(result.estimatedReadyAt).getTime() - now.getTime()).toBe(
        result.estimatedMinutes * 60_000,
      );
      return result;
    };

    // The steps share the growing queue, so they run in this order.
    it("KDS-06 an empty queue costs the service time only (fallback 600 s)", async () => {
      for (const channel of ["dine_in", "gofood", "takeaway"] as const) {
        const result = await eta(channel);
        expect(result.estimatedMinutes).toBe(FALLBACK_SERVICE_SECONDS / 60);
        expect(result.queueItems).toBe(0);
        expect(result.queueLoadPoints).toBe(0);
      }
    });

    it("KDS-06 queued points delay by points / throughput, rounded up, and dine_in is served first", async () => {
      await ticket(w, {
        stationId: dapur,
        channel: "dine_in",
        lines: lines(nasi, 10),
      });
      // dine_in waits behind dine_in only (10 pts / 2 per min = 5 min).
      expect((await eta("dine_in")).estimatedMinutes).toBe(5 + 10);
      // gofood waits behind dine_in and gofood (10 pts, none of its own yet).
      expect((await eta("gofood")).estimatedMinutes).toBe(5 + 10);

      await ticket(w, {
        stationId: dapur,
        channel: "gofood",
        lines: lines(nasi, 4),
      });
      const dineIn = await eta("dine_in");
      const gofood = await eta("gofood");
      expect(dineIn.estimatedMinutes).toBe(15); // gofood does not delay dine_in
      expect(gofood.estimatedMinutes).toBe(7 + 10); // 14 pts ahead
      expect(gofood.queueItems).toBe(14);
      expect(gofood.queueLoadPoints).toBe(14);
      // A channel the rule does not list waits behind everyone.
      expect((await eta("takeaway")).estimatedMinutes).toBe(17);
    });

    it("KDS-06 the estimate grows with the queue", async () => {
      const before = (await eta("gofood")).estimatedMinutes;
      await ticket(w, {
        stationId: dapur,
        channel: "dine_in",
        lines: lines(nasi, 10),
      });
      const dineIn = await eta("dine_in");
      const gofood = await eta("gofood");
      expect(dineIn.estimatedMinutes).toBe(10 + 10); // 20 pts ahead
      expect(gofood.estimatedMinutes).toBe(12 + 10); // 24 pts ahead
      expect(gofood.estimatedMinutes).toBeGreaterThan(before);
      expect(gofood.queueItems).toBe(24);
      expect(gofood.queueLoadPoints).toBe(24);
    });

    it("KDS-06 a partial minute rounds the delay up", async () => {
      await ticket(w, {
        stationId: dapur,
        channel: "gofood",
        lines: lines(nasi, 1),
      });
      // 25 pts ahead of gofood: ceil(12.5) = 13; dine_in is unchanged.
      expect((await eta("gofood")).estimatedMinutes).toBe(13 + 10);
      expect((await eta("dine_in")).estimatedMinutes).toBe(20);
    });

    it("KDS-06 the cart's own load points never lower the estimate", async () => {
      const plain = (await eta("gofood", 0)).estimatedMinutes;
      const heavy = (await eta("gofood", 100)).estimatedMinutes;
      expect(heavy).toBeGreaterThanOrEqual(plain);
    });

    it("KDS-06 finished tickets leave the queue", async () => {
      const done = await ticket(w, {
        stationId: dapur,
        channel: "dine_in",
        lines: lines(nasi, 20),
      });
      expect((await eta("dine_in")).estimatedMinutes).toBe(30);
      await finishTickets(w, [done], NOW);
      expect((await eta("dine_in")).estimatedMinutes).toBe(20);
    });
  });

  describe("history of finished tickets", () => {
    // One station only: the estimate endpoint reads the outlet's busiest
    // station, so a second one would make the pick ambiguous.
    let w: World;
    let dapur: string;
    let nasi: string;
    beforeAll(async () => {
      w = await makeWorld("hist");
      dapur = await station(w, {
        rules: [rule({ channelPriority: ["dine_in"] })],
      });
      nasi = await item(w, { stationId: dapur });
    });

    const done = (
      stationId: string,
      itemId: string,
      seconds: number,
      daysAgo: number,
    ) => {
      const doneAt = at(-daysAgo * 24 * 60);
      return ticket(w, {
        stationId,
        status: "done",
        lines: [{ itemId }],
        startedAt: new Date(doneAt.getTime() - seconds * 1000),
        doneAt,
        firedAt: new Date(doneAt.getTime() - seconds * 1000 - 5_000),
      });
    };
    const minutesFor = async () =>
      (
        await estimateServingTime(
          w.ctx,
          w.outlet,
          { channel: "dine_in", loadPoints: 0 },
          NOW,
        )
      ).estimatedMinutes;
    const historyOf = (stationId: string) =>
      inTx(w, (tx) => readStationHistory(tx, w.ctx, w.outlet, stationId, NOW));

    // These steps share the station's samples, so they run in this order.
    it("KDS-06 fewer than 5 samples are ignored: fallback service time", async () => {
      for (const seconds of [300, 900, 1500, 2100])
        await done(dapur, nasi, seconds, 1);
      expect(await historyOf(dapur)).toBeNull();
      expect(await minutesFor()).toBe(10);
    });

    it("KDS-06 with 5 samples the service time is their median, not their mean", async () => {
      await done(dapur, nasi, 3000, 2);
      // median 1500 s = 25 min (the mean, 1560 s, would give 26).
      expect(await historyOf(dapur)).toBe(1500);
      expect(await minutesFor()).toBe(25);
    });

    it("KDS-06 tickets finished more than 14 days ago do not count", async () => {
      for (let i = 0; i < 5; i += 1) await done(dapur, nasi, 7200, 15);
      expect(await historyOf(dapur)).toBe(1500);
      expect(await minutesFor()).toBe(25);
    });

    it("KDS-06 a station without samples, or with old or unfinished ones only, has no history", async () => {
      const idle = await station(w, { rules: [rule()] });
      const idleItem = await item(w, { stationId: idle });
      expect(await historyOf(idle)).toBeNull();
      for (let i = 0; i < 5; i += 1) await done(idle, idleItem, 7200, 15);
      for (let i = 0; i < 5; i += 1)
        await ticket(w, {
          stationId: idle,
          status: "cancelled",
          lines: [{ itemId: idleItem }],
          startedAt: at(-60),
          doneAt: null,
        });
      for (let i = 0; i < 5; i += 1)
        await ticket(w, {
          stationId: idle,
          status: "in_progress",
          lines: [{ itemId: idleItem }],
        });
      expect(await historyOf(idle)).toBeNull();
      // Samples inside the 14 days start to count.
      for (let i = 0; i < 5; i += 1) await done(idle, idleItem, 600, 13);
      expect(await historyOf(idle)).toBe(600);
    });
  });

  describe("QR/POS port (cart lines)", () => {
    let w: World;
    let dapur: string;
    let bar: string;
    let nasi: string;
    let kopi: string;
    let rendang: string;

    beforeAll(async () => {
      w = await makeWorld("port");
      dapur = await station(w, {
        rules: [rule({ capacityPoints: 30, channelPriority: ["dine_in"] })],
      });
      bar = await station(w, {
        type: "beverage_bar",
        targetSeconds: 300,
        rules: [rule({ capacityPoints: 30, channelPriority: ["dine_in"] })],
      });
      nasi = await item(w, { stationId: dapur });
      kopi = await item(w, { stationId: bar });
      rendang = await item(w, {
        stationId: dapur,
        load: { points: 3, prep: 1200 },
      });
    });

    const call = (
      cart: { menuItemId: string; target: number | null; quantity?: number }[],
    ) =>
      inTx(w, (tx) =>
        kdsServingEstimatePort(tx, w.ctx, {
          outletId: w.outletId,
          lines: cart.map((line) => ({
            menuItemId: line.menuItemId,
            quantity: line.quantity ?? 1,
            stationTargetSeconds: line.target,
          })),
          at: NOW,
        }),
      );

    it("KDS-05 the estimate is the slowest station the cart touches, with a range of at least 2 minutes", async () => {
      await ticket(w, {
        stationId: dapur,
        channel: "dine_in",
        lines: lines(nasi, 10),
      });
      // The cart's own load counts too (1 point x quantity 1 per line here).
      // Throughput of both stations: 30 pts / 15 min = 2 pts per minute.
      // Bar: queue ahead 0 + cart 1 pt = 1 pt -> ceil(1 / 2) = 1 min delay;
      //   service = station target 300 s; ETA = ceil((60 + 300) / 60) = 6;
      //   range 6 + max(2, ceil(1.5) = 2) = 8.
      expect(await call([{ menuItemId: kopi, target: 300 }])).toEqual({
        minMinutes: 6,
        maxMinutes: 8,
      });
      // Kitchen: queue ahead 10 pts (dine_in) + cart 1 pt = 11 pts
      //   -> ceil(11 / 2) = 6 min delay; service = fallback 600 s;
      //   ETA = ceil((360 + 600) / 60) = 16; range 16 + max(2, ceil(4)) = 20.
      expect(await call([{ menuItemId: nasi, target: null }])).toEqual({
        minMinutes: 16,
        maxMinutes: 20,
      });
      // A cart touching both takes the slower one (16 beats 6).
      expect(
        await call([
          { menuItemId: kopi, target: 300 },
          { menuItemId: nasi, target: null },
        ]),
      ).toEqual({ minMinutes: 16, maxMinutes: 20 });
    });

    it("KDS-05 the longest prep time among the cart's lines is the service time", async () => {
      // Both lines are on the kitchen. Cart load: nasi 1 pt (default) +
      // rendang 3 pts (load row) = 4 pts; queue ahead 10 pts -> 14 pts
      //   -> ceil(14 / 2) = 7 min delay. Service = longest prep of the cart =
      //   rendang 1200 s (vs. nasi fallback 600 s).
      //   ETA = ceil((420 + 1200) / 60) = 27; range 27 + max(2, ceil(6.75) = 7) = 34.
      expect(
        await call([
          { menuItemId: nasi, target: null },
          { menuItemId: rendang, target: null },
        ]),
      ).toEqual({ minMinutes: 27, maxMinutes: 34 });
    });

    it("KDS-05 once the queue drains the estimate falls back to the service time", async () => {
      const open = await owner.query<{ id: string }>(
        "SELECT id::text FROM kitchen_tickets WHERE tenant_id = $1 AND status = 'new'",
        [w.tenant.tenantId],
      );
      await finishTickets(
        w,
        open.rows.map((r) => r.id),
        NOW,
      );
      // Queue ahead 0, but the cart's own 1 pt still needs time:
      //   ceil(1 / 2) = 1 min delay; service fallback 600 s;
      //   ETA = ceil((60 + 600) / 60) = 11; range 11 + max(2, ceil(2.75) = 3) = 14.
      expect(await call([{ menuItemId: nasi, target: null }])).toEqual({
        minMinutes: 11,
        maxMinutes: 14,
      });
    });

    it("KDS-05 the cart's own load scales with the line quantity", async () => {
      // Queue is empty here. 3 x nasi = 3 pts -> ceil(3 / 2) = 2 min delay;
      //   service 600 s; ETA = ceil((120 + 600) / 60) = 12;
      //   range 12 + max(2, ceil(3) = 3) = 15.
      expect(
        await call([{ menuItemId: nasi, target: null, quantity: 3 }]),
      ).toEqual({ minMinutes: 12, maxMinutes: 15 });
    });

    it("KDS-05 installKdsServingEstimate registers the port the QR order uses", () => {
      setQrOrderServingEstimatePort(null);
      expect(qrOrderServingEstimatePort()).not.toBe(kdsServingEstimatePort);
      installKdsServingEstimate();
      expect(qrOrderServingEstimatePort()).toBe(kdsServingEstimatePort);
    });
  });
});

// ---- auto-pause --------------------------------------------------------------------

describe("auto-pause at capacity (KDS-05)", () => {
  let w: World;
  let dapur: string;
  let bar: string;
  let rendang: string;
  let soto: string;
  let bakso: string;
  let esteh: string;
  let mie: string;
  let pedas: string;
  let biasa: string;
  let wedang: string;
  const tickets: string[] = [];
  const T = (n: number) => at(n);

  beforeAll(async () => {
    w = await makeWorld("pause");
    // 10 points per 10 minutes; default prep is the station target (300 s).
    dapur = await station(w, {
      targetSeconds: 300,
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          channelPriority: ["dine_in", "gofood", "grabfood"],
        }),
      ],
    });
    bar = await station(w, {
      type: "beverage_bar",
      targetSeconds: 300,
      rules: [
        rule({ capacityPoints: 100, channelPriority: ["dine_in", "gofood"] }),
      ],
    });
    rendang = await item(w, {
      stationId: dapur,
      load: { points: 3, prep: 1200 },
    });
    soto = await item(w, {
      stationId: dapur,
      load: { points: 1, prep: LONG_PREP_SECONDS },
    });
    bakso = await item(w, {
      stationId: dapur,
      load: { points: 1, prep: LONG_PREP_SECONDS - 1 },
    });
    esteh = await item(w, { stationId: dapur });
    mie = await item(w, { stationId: dapur, load: { points: 1, prep: 100 } });
    pedas = await variant(w, mie, { points: 1, prep: 900 });
    biasa = await variant(w, mie);
    wedang = await item(w, { stationId: bar, load: { points: 1, prep: 1500 } });
  });

  const gofoodLines = () =>
    inTx(w, (tx) => readPausedMenuLines(tx, w.ctx, w.outlet, "gofood", T(0)));

  it("KDS-05 near capacity warns but pauses nothing", async () => {
    tickets.push(
      await ticket(w, {
        stationId: dapur,
        lines: [
          { itemId: rendang },
          { itemId: rendang },
          { itemId: esteh },
          { itemId: esteh },
        ],
      }),
    );
    const row = stationOf(await pacing(w, T(0)), dapur)!;
    expect(row.usedPoints).toBe(8);
    expect(row.status).toBe("near_capacity");
    expect(liveAuto(await pauseRows(w))).toHaveLength(0);
    expect(await listChannelPauses(w.ctx, w.outlet, T(0))).toEqual([]);
  });

  it("KDS-05 at capacity every long-prep line of the station is paused for all channels but the first", async () => {
    tickets.push(
      await ticket(w, {
        stationId: dapur,
        lines: [{ itemId: esteh }, { itemId: esteh }],
      }),
    );
    const row = stationOf(await pacing(w, T(1)), dapur)!;
    expect(row.usedPoints).toBe(10);
    expect(row.status).toBe("at_capacity");

    const pauses = await listChannelPauses(w.ctx, w.outlet, T(1));
    for (const pause of pauses) {
      expect(channelPauseSchema.parse(pause)).toEqual(pause);
      expect(pause).toMatchObject({
        tenantId: w.tenant.tenantId,
        outletId: w.outletId,
        reason: "station_capacity",
        pausedUntil: null,
        createdBy: null,
      });
      expect([...pause.channels].sort()).toEqual(["gofood", "grabfood"]);
    }
    // Rendang, soto (exactly the threshold) and the long mie variant; not
    // bakso (one second short), esteh, plain mie, biasa, nor the other station's wedang.
    expect(
      new Set(pauses.map((p) => lineKey(p.menuItemId, p.variantId))),
    ).toEqual(new Set([lineKey(rendang), lineKey(soto), lineKey(mie, pedas)]));
    expect(pauses).toHaveLength(3);
    for (const row of liveAuto(await pauseRows(w)))
      expect(row.station_id).toBe(dapur);
  });

  it("KDS-05 a second evaluation updates the live rows instead of stacking new ones", async () => {
    await pacing(w, T(2));
    await pacing(w, T(2));
    expect(liveAuto(await pauseRows(w))).toHaveLength(3);
    expect(await pauseRows(w)).toHaveLength(3);
  });

  it("KDS-05 the paused lines are read per channel; the top channel and unlisted channels are untouched", async () => {
    const forGofood = await gofoodLines();
    const forGrab = await inTx(w, (tx) =>
      readPausedMenuLines(tx, w.ctx, w.outlet, "grabfood", T(2)),
    );
    for (const set of [forGofood, forGrab]) {
      expect(isLinePaused(set, rendang, null)).toBe(true);
      expect(isLinePaused(set, soto, null)).toBe(true);
      expect(isLinePaused(set, mie, pedas)).toBe(true);
      expect(isLinePaused(set, mie, null)).toBe(false);
      expect(isLinePaused(set, mie, biasa)).toBe(false);
      expect(isLinePaused(set, bakso, null)).toBe(false);
      expect(isLinePaused(set, esteh, null)).toBe(false);
      expect(isLinePaused(set, wedang, null)).toBe(false);
    }
    for (const channel of ["dine_in", "takeaway"]) {
      const set = await inTx(w, (tx) =>
        readPausedMenuLines(tx, w.ctx, w.outlet, channel, T(2)),
      );
      expect(set.size).toBe(0);
    }
  });

  it("KDS-05 when the queue drains the pause is released at that moment", async () => {
    await finishTickets(w, tickets, T(3));
    const row = stationOf(await pacing(w, T(3)), dapur)!;
    expect(row.usedPoints).toBe(0);
    expect(row.status).toBe("available");
    expect(await listChannelPauses(w.ctx, w.outlet, T(3))).toEqual([]);
    expect((await gofoodLines()).size).toBe(0);
    const rows = await pauseRows(w);
    expect(rows).toHaveLength(3); // kept for audit, never deleted
    for (const released of rows) {
      expect(released.released_at).not.toBeNull();
      expect(released.released_at!.getTime()).toBe(T(3).getTime());
    }
  });

  it("KDS-05 filling the station again pauses the lines again with new rows", async () => {
    tickets.length = 0;
    tickets.push(
      await ticket(w, { stationId: dapur, lines: lines(rendang, 4) }),
    ); // 12
    const row = stationOf(await pacing(w, T(4)), dapur)!;
    expect(row.status).toBe("at_capacity");
    const rows = await pauseRows(w);
    expect(rows).toHaveLength(6);
    expect(liveAuto(rows)).toHaveLength(3);
    expect(await listChannelPauses(w.ctx, w.outlet, T(4))).toHaveLength(3);
  });

  it("KDS-05 going from at capacity back to near capacity lifts the pause too", async () => {
    // 12 pts -> 8 pts: still near capacity, no longer at capacity.
    await finishTickets(w, tickets, T(5));
    await ticket(w, {
      stationId: dapur,
      lines: [
        { itemId: rendang },
        { itemId: rendang },
        { itemId: esteh },
        { itemId: esteh },
      ],
    });
    const row = stationOf(await pacing(w, T(5)), dapur)!;
    expect(row.status).toBe("near_capacity");
    expect(liveAuto(await pauseRows(w))).toHaveLength(0);
  });

  describe("manual pauses and single-channel rules", () => {
    let m: World;
    let dapur2: string;
    let solo: string;
    let rendang2: string;
    let soloLong: string;
    let esteh2: string;
    let bakso2: string;
    let kopi2: string;
    let teh2: string;
    const manual: Record<string, string> = {};

    beforeAll(async () => {
      m = await makeWorld("manual");
      dapur2 = await station(m, {
        targetSeconds: 300,
        rules: [
          rule({
            windowMinutes: 10,
            capacityPoints: 10,
            channelPriority: ["dine_in", "gofood"],
          }),
        ],
      });
      // One channel only: there is nobody to pause for.
      solo = await station(m, {
        targetSeconds: 300,
        rules: [
          rule({
            windowMinutes: 10,
            capacityPoints: 5,
            channelPriority: ["dine_in"],
          }),
        ],
      });
      rendang2 = await item(m, {
        stationId: dapur2,
        load: { points: 5, prep: 1200 },
      });
      soloLong = await item(m, {
        stationId: solo,
        load: { points: 5, prep: 1200 },
      });
      esteh2 = await item(m, { stationId: dapur2 });
      bakso2 = await item(m, { stationId: dapur2 });
      kopi2 = await item(m, { stationId: dapur2 });
      teh2 = await item(m, { stationId: dapur2 });
      manual.forever = await insertPause(m, {
        menuItemId: esteh2,
        channels: ["gofood"],
      });
      manual.future = await insertPause(m, {
        menuItemId: bakso2,
        channels: ["gofood"],
        pausedUntil: at(60),
      });
      manual.expired = await insertPause(m, {
        menuItemId: kopi2,
        channels: ["gofood"],
        pausedUntil: at(-1),
      });
      manual.boundary = await insertPause(m, {
        menuItemId: teh2,
        channels: ["gofood"],
        pausedUntil: NOW,
      });
    });

    const liveFor = async (now: Date, channel = "gofood") =>
      inTx(m, (tx) => readPausedMenuLines(tx, m.ctx, m.outlet, channel, now));

    const manualRow = async (id: string) =>
      (await pauseRows(m, `id = '${id}'`))[0]!;

    it("KDS-05 a manual pause is live until it is released or runs out (until <= now is not live)", async () => {
      await pacing(m, NOW);
      const live = await listChannelPauses(m.ctx, m.outlet, NOW);
      expect(live.map((p) => p.id).sort()).toEqual(
        [manual.forever, manual.future].sort(),
      );
      for (const pause of live) {
        expect(channelPauseSchema.parse(pause)).toEqual(pause);
        expect(pause.reason).toBe("manual");
        expect(pause.channels).toEqual(["gofood"]);
      }
      const set = await liveFor(NOW);
      expect(set).toEqual(new Set([lineKey(esteh2), lineKey(bakso2)]));
      // Manual pauses name their channels: dine_in is not paused.
      expect((await liveFor(NOW, "dine_in")).size).toBe(0);
    });

    it("KDS-05 a manual pause expires by the clock alone", async () => {
      const later = at(61);
      await pacing(m, later);
      expect(
        new Set(
          (await listChannelPauses(m.ctx, m.outlet, later)).map((p) => p.id),
        ),
      ).toEqual(new Set([manual.forever]));
      expect(await liveFor(later)).toEqual(new Set([lineKey(esteh2)]));
    });

    it("KDS-05 the evaluator never changes manual rows, at capacity or after release", async () => {
      const before = await Promise.all(Object.values(manual).map(manualRow));
      const full = await ticket(m, {
        stationId: dapur2,
        lines: [{ itemId: rendang2 }, { itemId: rendang2 }],
      }); // 10
      expect(stationOf(await pacing(m, at(2)), dapur2)!.status).toBe(
        "at_capacity",
      );
      // The auto pause lands next to the manual ones.
      expect(await liveFor(at(2))).toEqual(
        new Set([lineKey(esteh2), lineKey(bakso2), lineKey(rendang2)]),
      );
      await finishTickets(m, [full], at(3));
      expect(stationOf(await pacing(m, at(3)), dapur2)!.status).toBe(
        "available",
      );
      expect(await liveFor(at(3))).toEqual(
        new Set([lineKey(esteh2), lineKey(bakso2)]),
      );
      const after = await Promise.all(Object.values(manual).map(manualRow));
      expect(after).toEqual(before);
      for (const row of after) expect(row.released_at).toBeNull();
    });

    it("KDS-05 a rule with a single channel pauses nothing, even at capacity", async () => {
      await ticket(m, { stationId: solo, lines: [{ itemId: soloLong }] }); // 5 of 5
      const row = stationOf(await pacing(m, at(4)), solo)!;
      expect(row.status).toBe("at_capacity");
      expect(await pauseRows(m, `station_id = '${solo}'`)).toEqual([]);
      for (const channel of ["dine_in", "gofood", "takeaway"])
        expect(
          isLinePaused(await liveFor(at(4), channel), soloLong, null),
        ).toBe(false);
    });
  });
});

// ---- review fixes: A3-A9 ------------------------------------------------------------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Holds the outlet's pacing advisory lock (the one evaluators take) on a
 * separate connection until `release` runs.
 */
async function holdPacingLock(outletId: string) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `kitchen-pacing:${outletId}`,
  ]);
  return async () => {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
}

const stateRowCount = async (w: World) =>
  Number(
    (
      await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM kitchen_pacing_state
          WHERE tenant_id = $1 AND outlet_id = $2`,
        [w.tenant.tenantId, w.outletId],
      )
    ).rows[0]!.n,
  );

/** The cart port with explicit quantities, inside the caller's tx. */
const portEta = (w: World, cart: { menuItemId: string; quantity?: number }[]) =>
  inTx(w, (tx) =>
    kdsServingEstimatePort(tx, w.ctx, {
      outletId: w.outletId,
      lines: cart.map((line) => ({
        menuItemId: line.menuItemId,
        quantity: line.quantity ?? 1,
        stationTargetSeconds: null,
      })),
      at: NOW,
    }),
  );

describe("A3 an outlet without capacity rules does no pacing work (KDS-05)", () => {
  // Fails without A3: the old staleness check saw "no state row" as stale, so
  // every call evaluated, wrote and took the outlet lock.
  it("KDS-05 no state rows are written and the outlet lock is never taken", async () => {
    const withStation = await makeWorld("norulea");
    const idle = await station(withStation, { rules: [] });
    const nasi = await item(withStation, {
      stationId: idle,
      load: { points: 2, prep: 1200 },
    });
    await ticket(withStation, { stationId: idle, lines: lines(nasi, 3) });
    const empty = await makeWorld("noruleb"); // no station at all

    for (const w of [withStation, empty]) {
      const release = await holdPacingLock(w.outletId);
      try {
        // With the lock held by someone else, an evaluator that takes the lock
        // would wait here. The 5 s timer only guards a failing run.
        const outcome = await Promise.race([
          evaluatePacingIfStale(w.ctx, w.outlet, NOW).then(() => "returned"),
          sleep(5_000).then(() => "blocked on the outlet lock"),
        ]);
        expect(outcome).toBe("returned");
      } finally {
        await release();
      }
      expect(await stateRowCount(w)).toBe(0);
      expect(await pauseRows(w)).toEqual([]);
    }
  });

  // Proves the probe above: with a rule in force the same call does need the lock.
  it("KDS-05 probe: with a rule in force the evaluator waits for the outlet lock, then records the state", async () => {
    const w = await makeWorld("rulelock");
    const dapur = await station(w, { rules: [rule()] });
    const release = await holdPacingLock(w.outletId);
    let settled = false;
    let pending: Promise<void> = Promise.resolve();
    try {
      pending = evaluatePacingIfStale(w.ctx, w.outlet, NOW).then(() => {
        settled = true;
      });
      await sleep(300);
      expect(settled).toBe(false);
    } finally {
      await release();
    }
    await pending;
    expect((await stateOf(w, dapur))!.evaluated_at.getTime()).toBe(
      NOW.getTime(),
    );
  });
});

describe("A4 menu lines follow the real KDS routing (KDS-05)", () => {
  // Used by the pause and ETA cases: an item has no station id, only the
  // brand-level station type, so the outlet's first station of that type serves it.
  it("routes an inactive target to the active station for ETA and automatic pauses", async () => {
    const w = await makeWorld("inactive-route");
    const inactive = await station(w, { type: "beverage_bar" });
    const active = await station(w, {
      type: "hot_kitchen",
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 4,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    await asOwnerTenant(w.tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE stations SET is_active = false WHERE id = $1`,
        [inactive],
      );
    });
    const target = await item(w, {
      stationId: inactive,
      stationType: "beverage_bar",
      load: { points: 3, prep: 1200 },
    });
    const filler = await item(w, { stationId: active });
    await ticket(w, {
      stationId: active,
      lines: [{ itemId: target }, { itemId: filler }],
    });
    expect(stationOf(await pacing(w, NOW), active)!.status).toBe("at_capacity");
    expect(
      liveAuto(await pauseRows(w)).map((row) => [
        row.menu_item_id,
        row.station_id,
      ]),
    ).toContainEqual([target, active]);
    expect(
      (await portEta(w, [{ menuItemId: target }]))!.minMinutes,
    ).toBeGreaterThan(20);
  });

  it("KDS-05 an item routed by station type (no station id) is auto-paused at capacity", async () => {
    // Fails without A4: only items with menu_items.station_id were found.
    const w = await makeWorld("typepause");
    const dapur = await station(w, {
      type: "hot_kitchen",
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 4,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    const rendang = await item(w, {
      stationId: null,
      stationType: "hot_kitchen",
      load: { points: 3, prep: 1200 },
    });
    const esteh = await item(w, {
      stationId: null,
      stationType: "hot_kitchen",
    });
    await ticket(w, {
      stationId: dapur,
      lines: [{ itemId: rendang }, { itemId: esteh }],
    }); // 3 + 1 = 4 of 4
    expect(stationOf(await pacing(w, NOW), dapur)!.status).toBe("at_capacity");
    const live = liveAuto(await pauseRows(w));
    expect(live.map((r) => lineKey(r.menu_item_id, r.variant_id))).toEqual([
      lineKey(rendang),
    ]);
    expect(live[0]!.station_id).toBe(dapur);
    expect(live[0]!.channels).toEqual(["gofood"]);
    const paused = await inTx(w, (tx) =>
      readPausedMenuLines(tx, w.ctx, w.outlet, "gofood", NOW),
    );
    expect(isLinePaused(paused, rendang, null)).toBe(true);
  });

  it("KDS-05 an item routed by station type is counted in the cart ETA", async () => {
    // Fails without A4: such an item touched no station, so the estimate fell
    // back to the bare service time (10 / 13).
    const w = await makeWorld("typeeta");
    const dapur = await station(w, {
      type: "hot_kitchen",
      rules: [rule({ capacityPoints: 30, channelPriority: ["dine_in"] })],
    });
    const nasi = await item(w, { stationId: null, stationType: "hot_kitchen" });
    await ticket(w, {
      stationId: dapur,
      channel: "dine_in",
      lines: lines(nasi, 10),
    });
    // Throughput 30 / 15 min = 2 pts per minute. Queue ahead 10 pts + cart 1 pt
    // = 11 -> ceil(5.5) = 6 min; service fallback 600 s;
    // ETA = ceil((360 + 600) / 60) = 16; range 16 + max(2, ceil(4)) = 20.
    expect(await portEta(w, [{ menuItemId: nasi }])).toEqual({
      minMinutes: 16,
      maxMinutes: 20,
    });
  });

  it("KDS-05 a station id of another outlet is no override: the item falls back to its station type (ETA)", async () => {
    // Fails without A4: the foreign station id was taken as is, so the item
    // touched no station of this outlet (10 / 13).
    const w = await makeWorld("foreigneta");
    const outletB = await addOutlet(w);
    const foreign = await station(w, {
      outletId: outletB,
      type: "beverage_bar",
    });
    const dapur = await station(w, {
      type: "hot_kitchen",
      rules: [rule({ capacityPoints: 30, channelPriority: ["dine_in"] })],
    });
    const bar = await station(w, {
      type: "beverage_bar",
      rules: [rule({ capacityPoints: 30, channelPriority: ["dine_in"] })],
    });
    const nasi = await item(w, {
      stationId: foreign,
      stationType: "hot_kitchen",
    });
    const filler = await item(w, { stationId: dapur });
    await ticket(w, {
      stationId: dapur,
      channel: "dine_in",
      lines: lines(filler, 10),
    });
    // Routed by type to the kitchen (not to the bar, not to nothing): the same
    // arithmetic as above gives 16 / 20. The idle bar would give 11 / 14.
    expect(await portEta(w, [{ menuItemId: nasi }])).toEqual({
      minMinutes: 16,
      maxMinutes: 20,
    });
    expect(stationOf(await pacing(w, NOW), bar)!.usedPoints).toBe(0);
  });

  it("KDS-05 a station id of another outlet is no override: the item falls back to its station type (auto-pause)", async () => {
    const w = await makeWorld("foreignpause");
    const outletB = await addOutlet(w);
    const foreign = await station(w, {
      outletId: outletB,
      type: "beverage_bar",
    });
    const dapur = await station(w, {
      type: "hot_kitchen",
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 4,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    const rendang = await item(w, {
      stationId: foreign,
      stationType: "hot_kitchen",
      load: { points: 3, prep: 1200 },
    });
    const esteh = await item(w, { stationId: dapur });
    await ticket(w, {
      stationId: dapur,
      lines: [{ itemId: rendang }, { itemId: esteh }],
    }); // 3 + 1 = 4 of 4
    expect(stationOf(await pacing(w, NOW), dapur)!.status).toBe("at_capacity");
    const live = liveAuto(await pauseRows(w));
    expect(live.map((r) => lineKey(r.menu_item_id, r.variant_id))).toEqual([
      lineKey(rendang),
    ]);
    expect(live[0]!.station_id).toBe(dapur);
  });
});

describe("A5 a pause of a removed station is released (KDS-05)", () => {
  // Fails without A5: pauses of a soft-deleted station were never synced, so
  // they stayed live for ever.
  const softDelete = (w: World, stationId: string) =>
    asOwnerTenant(w.tenant.tenantId, (client) =>
      client.query(
        "UPDATE stations SET deleted_at = now() WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, stationId],
      ),
    );

  async function fullKitchen(w: World) {
    const dapur = await station(w, {
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 4,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    const rendang = await item(w, {
      stationId: dapur,
      load: { points: 3, prep: 1200 },
    });
    const esteh = await item(w, { stationId: dapur });
    await ticket(w, {
      stationId: dapur,
      lines: [{ itemId: rendang }, { itemId: esteh }],
    });
    expect(stationOf(await pacing(w, NOW), dapur)!.status).toBe("at_capacity");
    expect(liveAuto(await pauseRows(w))).toHaveLength(1);
    return { dapur, rendang };
  }

  it("KDS-05 the pause is released while another live station remains", async () => {
    const w = await makeWorld("gone");
    const { dapur, rendang } = await fullKitchen(w);
    await station(w, { type: "beverage_bar", rules: [rule()] });
    await softDelete(w, dapur);
    const later = at(1);
    await pacing(w, later);
    const rows = await pauseRows(w);
    expect(liveAuto(rows)).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.released_at!.getTime()).toBe(later.getTime());
    expect(await listChannelPauses(w.ctx, w.outlet, later)).toEqual([]);
    const paused = await inTx(w, (tx) =>
      readPausedMenuLines(tx, w.ctx, w.outlet, "gofood", later),
    );
    expect(isLinePaused(paused, rendang, null)).toBe(false);
  });

  it("KDS-05 the pause is released when no live station is left, also by evaluate-on-read", async () => {
    const w = await makeWorld("gonelast");
    const { dapur } = await fullKitchen(w);
    await softDelete(w, dapur);
    const later = at(1);
    await evaluatePacingIfStale(w.ctx, w.outlet, later);
    const rows = await pauseRows(w);
    expect(liveAuto(rows)).toHaveLength(0);
    expect(rows[0]!.released_at!.getTime()).toBe(later.getTime());
  });
});

describe("A6 an item-level pause does not block a variant with its own short load (KDS-05)", () => {
  it("KDS-05 the variant with a short load row stays orderable, its sibling without a row is paused", async () => {
    // Fails without A6: the pause was stored at item level and blocked every
    // variant, including the one with its own 100 s load.
    const w = await makeWorld("variant");
    const dapur = await station(w, {
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    const mie = await item(w, {
      stationId: dapur,
      load: { points: 1, prep: LONG_PREP_SECONDS + 600 }, // item level: 1200 s
    });
    const cepat = await variant(w, mie, { points: 1, prep: 100 }); // own short row
    const biasa = await variant(w, mie); // no row: inherits the item's 1200 s
    const esteh = await item(w, { stationId: dapur });
    await ticket(w, { stationId: dapur, lines: lines(esteh, 10) }); // 10 of 10
    expect(stationOf(await pacing(w, NOW), dapur)!.status).toBe("at_capacity");

    const live = liveAuto(await pauseRows(w));
    expect(live.map((r) => lineKey(r.menu_item_id, r.variant_id))).toEqual([
      lineKey(mie, biasa),
    ]);
    const paused = await inTx(w, (tx) =>
      readPausedMenuLines(tx, w.ctx, w.outlet, "gofood", NOW),
    );
    expect(isLinePaused(paused, mie, biasa)).toBe(true);
    expect(isLinePaused(paused, mie, cepat)).toBe(false);
    expect(isLinePaused(paused, mie, null)).toBe(false);
    // The top channel is never paused.
    const forDineIn = await inTx(w, (tx) =>
      readPausedMenuLines(tx, w.ctx, w.outlet, "dine_in", NOW),
    );
    expect(forDineIn.size).toBe(0);
  });
});

describe("A7 queueItems is the sum of quantity (KDS-06)", () => {
  it("KDS-06 the estimate and the pacing snapshot both count units, not lines", async () => {
    // Fails without A7: queueItems counted the lines (3 here), not the units (9).
    const w = await makeWorld("qty");
    const dapur = await station(w, {
      rules: [rule({ channelPriority: ["dine_in", "gofood"] })],
    });
    const nasi = await item(w, { stationId: dapur });
    await ticket(w, {
      stationId: dapur,
      status: "new",
      lines: [
        { itemId: nasi, qty: 3 },
        { itemId: nasi, qty: 2 },
      ],
    });
    await ticket(w, {
      stationId: dapur,
      status: "in_progress",
      lines: [{ itemId: nasi, qty: 4 }],
    });
    const snapshot = await pacing(w, NOW);
    expect(stationOf(snapshot, dapur)!.queuedItems).toBe(9);
    expect(stationOf(snapshot, dapur)!.usedPoints).toBe(9);

    const estimate = await estimateServingTime(
      w.ctx,
      w.outlet,
      { channel: "dine_in", loadPoints: 0 },
      NOW,
    );
    expect(servingTimeEstimateSchema.parse(estimate)).toEqual(estimate);
    expect(estimate.queueItems).toBe(9);
    expect(estimate.queueLoadPoints).toBe(9);
    // 9 pts at 2 pts per minute = ceil(4.5) = 5 min + 600 s service = 15.
    expect(estimate.estimatedMinutes).toBe(15);
  });
});

describe("A9 pacing time never moves backwards (KDS-05)", () => {
  it("KDS-05 evaluating with an earlier clock keeps evaluatedAt, changedAt, pause and release stamps at the last time", async () => {
    // Fails without A9: the stamps took the reader's older `now`.
    const w = await makeWorld("mono");
    const dapur = await station(w, {
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 4,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    const rendang = await item(w, {
      stationId: dapur,
      load: { points: 3, prep: 1200 },
    });
    const esteh = await item(w, { stationId: dapur });
    const late = at(5);
    const early = NOW; // 5 minutes before `late`

    await pacing(w, late);
    const first = (await stateOf(w, dapur))!;
    expect(first.evaluated_at.getTime()).toBe(late.getTime());
    expect(first.changed_at.getTime()).toBe(late.getTime());

    // The level changes (available -> at capacity) at an earlier `now`.
    const full = await ticket(w, {
      stationId: dapur,
      lines: [{ itemId: rendang }, { itemId: esteh }],
    });
    await pacing(w, early);
    const second = (await stateOf(w, dapur))!;
    expect(second.level).toBe("at_capacity");
    expect(second.evaluated_at.getTime()).toBe(late.getTime());
    expect(second.changed_at.getTime()).toBe(late.getTime());
    const created = liveAuto(await pauseRows(w));
    expect(created).toHaveLength(1);
    const createdAt = (
      await owner.query<{ created_at: Date }>(
        "SELECT created_at FROM kitchen_channel_pauses WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, created[0]!.id],
      )
    ).rows[0]!.created_at;
    expect(createdAt.getTime()).toBe(late.getTime());

    // The pause is released at an earlier `now`: stamped with the last time.
    await finishTickets(w, [full], late);
    await pacing(w, early);
    const third = (await stateOf(w, dapur))!;
    expect(third.level).toBe("available");
    expect(third.evaluated_at.getTime()).toBe(late.getTime());
    expect(third.changed_at.getTime()).toBe(late.getTime());
    const rows = await pauseRows(w);
    expect(liveAuto(rows)).toHaveLength(0);
    expect(rows[0]!.released_at!.getTime()).toBe(late.getTime());

    // A later clock moves time forward again.
    const next = at(10);
    await pacing(w, next);
    expect((await stateOf(w, dapur))!.evaluated_at.getTime()).toBe(
      next.getTime(),
    );
  });
});

// ---- supervisor alerts -------------------------------------------------------------

describe("supervisor alert on a capacity transition (KDS-05)", () => {
  let w: World;
  let dapur: string;
  let kopi: string;
  let manager: Member;
  let cook: Member;
  let otherOutletManager: Member;
  const T = (n: number) => at(n);

  beforeAll(async () => {
    w = await makeWorld("alert");
    const manageRole = await insertRole(w.tenant.tenantId, "Pengelola Alert", [
      "kds.station.manage",
    ]);
    const cookRole = await insertRole(
      w.tenant.tenantId,
      "Koki Alert",
      ["kds.ticket.process"],
      ["tenant", "outlet", "station"],
    );
    const outletB = await addOutlet(w);
    manager = await member(
      app,
      w.tenant.tenantId,
      manageRole,
      { type: "tenant", id: null },
      "Alert Pengelola",
    );
    cook = await member(
      app,
      w.tenant.tenantId,
      cookRole,
      { type: "tenant", id: null },
      "Alert Koki",
    );
    otherOutletManager = await member(
      app,
      w.tenant.tenantId,
      manageRole,
      { type: "outlet", id: outletB },
      "Alert Outlet B",
    );
    dapur = await station(w, {
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          channelPriority: ["dine_in", "gofood"],
        }),
      ],
    });
    kopi = await item(w, { stationId: dapur });
  });

  const alerts = async (name: "near_capacity" | "at_capacity") => {
    const { rows } = await owner.query<{ user_id: string; category: string }>(
      `SELECT n.user_id::text AS user_id, n.category
         FROM notifications n
         JOIN notification_outbox o
           ON o.tenant_id = n.tenant_id AND o.source_event_id = n.source_event_id
        WHERE n.tenant_id = $1 AND o.event_type = $2`,
      [w.tenant.tenantId, `kitchen_pacing.${name}`],
    );
    return rows;
  };

  const open: string[] = [];

  it("KDS-05 no alert while the station is available", async () => {
    await pacing(w, T(0));
    await pacing(w, T(1));
    expect(await alerts("near_capacity")).toEqual([]);
    expect(await alerts("at_capacity")).toEqual([]);
  });

  it("KDS-05 entering near capacity alerts the station managers once, however often it is read", async () => {
    open.push(await ticket(w, { stationId: dapur, lines: lines(kopi, 8) }));
    expect(stationOf(await pacing(w, T(2)), dapur)!.status).toBe(
      "near_capacity",
    );
    const first = await alerts("near_capacity");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      user_id: manager.userId,
      category: "kitchen_alert",
    });
    // The same level read again, later: still one notification.
    await pacing(w, T(2));
    await pacing(w, T(3));
    await evaluatePacingIfStale(w.ctx, w.outlet, T(10));
    expect(await alerts("near_capacity")).toHaveLength(1);
    // A cook and a manager of another outlet are not the audience.
    for (const kind of ["near_capacity", "at_capacity"] as const)
      for (const row of await alerts(kind)) {
        expect(row.user_id).not.toBe(cook.userId);
        expect(row.user_id).not.toBe(otherOutletManager.userId);
      }
  });

  it("KDS-05 entering at capacity alerts once, even when the reads run concurrently", async () => {
    open.push(await ticket(w, { stationId: dapur, lines: lines(kopi, 2) }));
    const snapshots = await Promise.all([
      evaluatePacing(w.ctx, w.outlet, T(11)),
      evaluatePacing(w.ctx, w.outlet, T(11)),
      evaluatePacing(w.ctx, w.outlet, T(11)),
    ]);
    for (const snapshot of snapshots)
      expect(stationOf(snapshot, dapur)!.status).toBe("at_capacity");
    const rows = await alerts("at_capacity");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: manager.userId,
      category: "kitchen_alert",
    });
    expect(await alerts("near_capacity")).toHaveLength(1);
  });

  it("KDS-05 getting better (at capacity to near capacity) raises no alert", async () => {
    await finishTickets(w, open.splice(1), T(12)); // leaves 8 points
    expect(stationOf(await pacing(w, T(12)), dapur)!.status).toBe(
      "near_capacity",
    );
    expect(await alerts("near_capacity")).toHaveLength(1);
    expect(await alerts("at_capacity")).toHaveLength(1);
  });

  it("KDS-05 release to available raises no alert", async () => {
    await finishTickets(w, open.splice(0), T(13));
    expect(stationOf(await pacing(w, T(13)), dapur)!.status).toBe("available");
    await pacing(w, T(14));
    expect(await alerts("near_capacity")).toHaveLength(1);
    expect(await alerts("at_capacity")).toHaveLength(1);
  });

  it("KDS-05 a new transition into at capacity alerts again", async () => {
    await ticket(w, { stationId: dapur, lines: lines(kopi, 10) });
    expect(stationOf(await pacing(w, T(20)), dapur)!.status).toBe(
      "at_capacity",
    );
    expect(await alerts("at_capacity")).toHaveLength(2);
    await pacing(w, T(21));
    expect(await alerts("at_capacity")).toHaveLength(2);
    expect(await alerts("near_capacity")).toHaveLength(1);
  });
});

// ---- menu loads --------------------------------------------------------------------

describe("menu loads", () => {
  let w: World;
  let other: World;
  let outletB: string;
  let dapur: string;
  let nasi: string;
  let mie: string;
  let pedas: string;
  let foreignItem: string;

  const storedCount = async (outletId = w.outletId, menuItemId = nasi) => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM kitchen_menu_loads
        WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3`,
      [w.tenant.tenantId, outletId, menuItemId],
    );
    return Number(rows[0]!.n);
  };

  beforeAll(async () => {
    w = await makeWorld("load");
    other = await makeWorld("loadx");
    outletB = await addOutlet(w);
    dapur = await station(w);
    nasi = await item(w, { stationId: dapur });
    mie = await item(w, { stationId: dapur });
    pedas = await variant(w, mie);
    foreignItem = await item(other);
  });

  it("KDS-05 stores item-level and variant loads and reads them back with the contract shape", async () => {
    expect(await listMenuLoads(w.ctx, w.outlet)).toEqual([]);
    const stored = await setMenuLoads(
      w.ctx,
      w.outlet,
      [
        { menuItemId: nasi, variantId: null, loadPoints: 3, prepSeconds: 900 },
        { menuItemId: mie, variantId: pedas, loadPoints: 5, prepSeconds: 1200 },
      ],
      NOW,
    );
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(menuLoadSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        tenantId: w.tenant.tenantId,
        outletId: w.outletId,
      });
    }
    const listed = await listMenuLoads(w.ctx, w.outlet);
    expect(listed).toHaveLength(2);
    expect(listed.find((r) => r.menuItemId === nasi)).toMatchObject({
      variantId: null,
      loadPoints: 3,
      prepSeconds: 900,
    });
    expect(listed.find((r) => r.menuItemId === mie)).toMatchObject({
      variantId: pedas,
      loadPoints: 5,
      prepSeconds: 1200,
    });
  });

  it("KDS-05 setting a line again updates it in place", async () => {
    const before = (await listMenuLoads(w.ctx, w.outlet)).find(
      (r) => r.menuItemId === nasi,
    )!;
    await setMenuLoads(
      w.ctx,
      w.outlet,
      [{ menuItemId: nasi, variantId: null, loadPoints: 4, prepSeconds: 600 }],
      at(1),
    );
    expect(await storedCount()).toBe(1);
    const after = (await listMenuLoads(w.ctx, w.outlet)).find(
      (r) => r.menuItemId === nasi,
    )!;
    expect(after).toMatchObject({
      id: before.id,
      loadPoints: 4,
      prepSeconds: 600,
    });
    expect(await listMenuLoads(w.ctx, w.outlet)).toHaveLength(2);
  });

  it("KDS-05 a new load changes the used points the next read shows", async () => {
    const id = await station(w, { rules: [rule({ capacityPoints: 100 })] });
    const bakso = await item(w, { stationId: id });
    await ticket(w, { stationId: id, lines: [{ itemId: bakso, qty: 2 }] });
    expect(stationOf(await pacing(w, NOW), id)!.usedPoints).toBe(2);
    await setMenuLoads(
      w.ctx,
      w.outlet,
      [{ menuItemId: bakso, variantId: null, loadPoints: 6, prepSeconds: 300 }],
      NOW,
    );
    expect(stationOf(await pacing(w, NOW), id)!.usedPoints).toBe(12);
  });

  it("KDS-05 rejects an unknown item and a foreign tenant's item, and stores nothing of the batch", async () => {
    const before = (await listMenuLoads(w.ctx, w.outlet)).length;
    for (const menuItemId of [randomUUID(), foreignItem])
      await expect(
        setMenuLoads(
          w.ctx,
          w.outlet,
          [
            {
              menuItemId: mie,
              variantId: null,
              loadPoints: 2,
              prepSeconds: 100,
            },
            { menuItemId, variantId: null, loadPoints: 2, prepSeconds: 100 },
          ],
          NOW,
        ),
      ).rejects.toThrow();
    expect(await listMenuLoads(w.ctx, w.outlet)).toHaveLength(before);
    expect(
      (await listMenuLoads(w.ctx, w.outlet)).find(
        (r) => r.menuItemId === mie && r.variantId === null,
      ),
    ).toBeUndefined();
    expect(await storedCount(w.outletId, foreignItem)).toBe(0);
  });

  it.each([
    ["zero points", { loadPoints: 0, prepSeconds: 60 }],
    ["above 100 points", { loadPoints: 101, prepSeconds: 60 }],
    ["fractional points", { loadPoints: 1.5, prepSeconds: 60 }],
    ["zero seconds", { loadPoints: 1, prepSeconds: 0 }],
    ["above 7200 seconds", { loadPoints: 1, prepSeconds: 7201 }],
  ])("KDS-05 rejects %s", async (_label, values) => {
    const before = await listMenuLoads(w.ctx, w.outlet);
    await expect(
      setMenuLoads(
        w.ctx,
        w.outlet,
        [{ menuItemId: nasi, variantId: null, ...values }],
        NOW,
      ),
    ).rejects.toThrow();
    expect(await listMenuLoads(w.ctx, w.outlet)).toEqual(before);
  });

  it("KDS-05 loads belong to one outlet", async () => {
    await setMenuLoads(
      w.ctx,
      oid(outletB),
      [{ menuItemId: nasi, variantId: null, loadPoints: 9, prepSeconds: 60 }],
      NOW,
    );
    const inB = await listMenuLoads(w.ctx, oid(outletB));
    expect(inB).toHaveLength(1);
    expect(inB[0]).toMatchObject({ outletId: outletB, loadPoints: 9 });
    const inA = await listMenuLoads(w.ctx, w.outlet);
    expect(inA.every((row) => row.outletId === w.outletId)).toBe(true);
    expect(inA.find((r) => r.menuItemId === nasi)!.loadPoints).toBe(4);
  });
});

// ---- queue read --------------------------------------------------------------------

describe("station queue read", () => {
  it("KDS-05 lists the open lines per station with channel, points and prep seconds", async () => {
    const w = await makeWorld("queue");
    const dapur = await station(w, { targetSeconds: 300, rules: [rule()] });
    const rendang = await item(w, {
      stationId: dapur,
      load: { points: 3, prep: 1200 },
    });
    const esteh = await item(w, { stationId: dapur });
    await ticket(w, {
      stationId: dapur,
      channel: "dine_in",
      lines: [{ itemId: rendang, qty: 2 }],
    });
    await ticket(w, {
      stationId: dapur,
      channel: "gofood",
      status: "in_progress",
      lines: [{ itemId: esteh, qty: 4 }],
    });
    await ticket(w, {
      stationId: dapur,
      channel: "gofood",
      status: "done",
      lines: [{ itemId: esteh, qty: 9 }],
    });
    const queue = await inTx(w, (tx) => readStationQueue(tx, w.ctx, w.outlet));
    const row = queue.find((entry) => entry.stationId === dapur)!;
    expect(row).toBeDefined();
    const pointsBy = (channel: string) =>
      row.items
        .filter((i) => i.channel === channel)
        .reduce((sum, i) => sum + i.points, 0);
    expect(pointsBy("dine_in")).toBe(6);
    expect(pointsBy("gofood")).toBe(4);
    expect(
      row.items.every((i) => ["dine_in", "gofood"].includes(i.channel)),
    ).toBe(true);
    expect(
      row.items
        .filter((i) => i.channel === "dine_in")
        .every((i) => i.prepSeconds === 1200),
    ).toBe(true);
    expect(
      row.items
        .filter((i) => i.channel === "gofood")
        .every((i) => i.prepSeconds === 300),
    ).toBe(true);
  });
});

// ---- POS admission -----------------------------------------------------------------

describe("POS admission of paused lines (KDS-05)", () => {
  let w: World;
  let cashier: Member;
  let dapur: string;
  let rendang: string;
  let esteh: string;
  let kopi: string;
  let manualKopi: string;
  const open: string[] = [];

  beforeAll(async () => {
    w = await makeWorld("pos");
    const role = await insertRole(
      w.tenant.tenantId,
      "Kasir Pacing",
      ["order.view", "pos.sale.create"],
      ["tenant"],
    );
    cashier = await member(
      app,
      w.tenant.tenantId,
      role,
      { type: "tenant", id: null },
      "Kasir Pacing",
    );
    // 10 points per 10 minutes; takeaway is behind dine_in. Real clock: the
    // HTTP request evaluates "now".
    dapur = await station(w, {
      targetSeconds: 300,
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          schedule: scheduleAroundNow(),
          channelPriority: ["dine_in", "takeaway"],
        }),
      ],
    });
    rendang = await item(w, {
      name: "Rendang",
      stationId: dapur,
      load: { points: 3, prep: 1200 },
    });
    esteh = await item(w, {
      name: "Es Teh",
      stationId: dapur,
      load: { points: 1, prep: 120 },
    });
    kopi = await item(w, {
      name: "Kopi",
      stationId: dapur,
      load: { points: 1, prep: 120 },
    });
    await asOwnerTenant(w.tenant.tenantId, async (client) => {
      for (const channel of ["dine_in", "takeaway"]) {
        const priceList = randomUUID();
        await client.query(
          `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
           VALUES ($1, $2, $3, $4, '2026-01-01')`,
          [priceList, w.tenant.tenantId, w.outletId, channel],
        );
        for (const [menuItemId, price] of [
          [rendang, 30_000],
          [esteh, 10_000],
          [kopi, 15_000],
        ] as const)
          await client.query(
            `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
             VALUES ($1, $2, $3, $4, $5)`,
            [randomUUID(), w.tenant.tenantId, priceList, menuItemId, price],
          );
      }
      await client.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                 'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), w.tenant.tenantId, cashier.userId],
      );
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'PBJT-PAC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                 '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), w.tenant.tenantId, cashier.userId],
      );
    });
    manualKopi = await insertPause(w, {
      menuItemId: kopi,
      channels: ["takeaway"],
    });
  });

  const create = (serviceType: "dine_in" | "takeaway", menuItemIds: string[]) =>
    cashier.client
      .post(`/api/outlets/${encodeURIComponent(w.outletId)}/pos/orders`)
      .set({ Host: w.tenant.hostname })
      .set(originHeader)
      .send({
        idempotencyKey: randomUUID(),
        channel: "pos",
        serviceType,
        items: menuItemIds.map((menuItemId) => ({
          menuItemId,
          quantity: 1,
          modifierIds: [],
        })),
      });

  const orderCount = async () => {
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1 AND channel = 'pos'",
      [w.tenant.tenantId],
    );
    // The seeded queue orders are also `pos`: only compare before/after.
    return Number(rows[0]!.n);
  };

  const expectPaused = (res: {
    status: number;
    body: { error?: { code?: string; message?: string } };
  }) => {
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe("CONFLICT");
    expect(res.body.error?.message).toMatch(/KDS-05/);
  };

  it("KDS-05 a line paused for the order's channel is refused, nothing is created", async () => {
    open.push(
      await ticket(w, {
        stationId: dapur,
        channel: "dine_in",
        lines: [
          { itemId: rendang },
          { itemId: rendang },
          { itemId: rendang },
          { itemId: esteh },
        ],
      }),
    ); // 10 of 10: at capacity, never evaluated before the request
    const before = await orderCount();
    expectPaused(await create("takeaway", [rendang]));
    expectPaused(await create("takeaway", [esteh, rendang]));
    expect(await orderCount()).toBe(before);
  });

  it("KDS-05 the top-priority channel and short-prep lines are still accepted", async () => {
    const dineIn = await create("dine_in", [rendang]);
    expect(dineIn.status, JSON.stringify(dineIn.body)).toBe(201);
    const shortPrep = await create("takeaway", [esteh]);
    expect(shortPrep.status, JSON.stringify(shortPrep.body)).toBe(201);
  });

  it("KDS-05 once the queue drains the same line is accepted again", async () => {
    await finishTickets(w, open, new Date());
    // The refusal above cached a state; age it past the 10 s refresh.
    await owner.query(
      `UPDATE kitchen_pacing_state SET evaluated_at = evaluated_at - interval '5 minutes'
        WHERE tenant_id = $1`,
      [w.tenant.tenantId],
    );
    const res = await create("takeaway", [rendang]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("KDS-05 a manual pause refuses its channel only", async () => {
    expectPaused(await create("takeaway", [kopi]));
    const dineIn = await create("dine_in", [kopi]);
    expect(dineIn.status, JSON.stringify(dineIn.body)).toBe(201);
  });

  it("KDS-05 a manual pause that has run out no longer refuses", async () => {
    await owner.query(
      `UPDATE kitchen_channel_pauses SET paused_until = now() - interval '1 minute' WHERE id = $1`,
      [manualKopi],
    );
    const res = await create("takeaway", [kopi]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// ---- routes ------------------------------------------------------------------------

describe("routes GET /kitchen/pacing and GET /serving-time-estimate", () => {
  let w: World;
  let other: World;
  let outletB: string;
  let headers: { Host: string };
  let headersOther: { Host: string };
  let cook: Member;
  let cashier: Member;
  let noAccess: Member;
  let outletBCook: Member;
  let otherCook: Member;
  let dapur: string;
  let nasi: string;

  beforeAll(async () => {
    w = await makeWorld("http");
    other = await makeWorld("httpx");
    outletB = await addOutlet(w);
    headers = { Host: w.tenant.hostname };
    headersOther = { Host: other.tenant.hostname };
    const cookRole = await insertRole(
      w.tenant.tenantId,
      "Koki Rute",
      ["kds.ticket.process"],
      ["tenant", "outlet", "station"],
    );
    const cashierRole = await insertRole(
      w.tenant.tenantId,
      "Kasir Rute",
      ["order.view", "pos.sale.create"],
      ["tenant"],
    );
    const noRole = await insertRole(
      w.tenant.tenantId,
      "Tanpa KDS Rute",
      ["floor.table.view"],
      ["tenant"],
    );
    const otherRole = await insertRole(
      other.tenant.tenantId,
      "Koki Tenant Lain",
      ["kds.ticket.process"],
      ["tenant"],
    );
    cook = await member(
      app,
      w.tenant.tenantId,
      cookRole,
      { type: "tenant", id: null },
      "Rute Koki",
    );
    cashier = await member(
      app,
      w.tenant.tenantId,
      cashierRole,
      { type: "tenant", id: null },
      "Rute Kasir",
    );
    noAccess = await member(
      app,
      w.tenant.tenantId,
      noRole,
      { type: "tenant", id: null },
      "Rute Tanpa",
    );
    outletBCook = await member(
      app,
      w.tenant.tenantId,
      cookRole,
      { type: "outlet", id: outletB },
      "Rute Outlet B",
    );
    otherCook = await member(
      app,
      other.tenant.tenantId,
      otherRole,
      { type: "tenant", id: null },
      "Rute Lain",
    );
    // 10 points per 10 minutes = 1 point per minute, default prep 600 s.
    dapur = await station(w, {
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          schedule: scheduleAroundNow(),
        }),
      ],
    });
    nasi = await item(w, { stationId: dapur });
    await ticket(w, {
      stationId: dapur,
      channel: "dine_in",
      lines: lines(nasi, 4),
    });
    await ticket(w, {
      stationId: dapur,
      channel: "gofood",
      lines: lines(nasi, 2),
    });
    // Outlet B has a station but no rule: the empty state.
    await station(w, { outletId: outletB, rules: [] });
    // The other tenant has its own busy station: it must never show up here.
    const foreign = await station(other, {
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          schedule: scheduleAroundNow(),
        }),
      ],
    });
    const foreignItem = await item(other, { stationId: foreign });
    await ticket(other, { stationId: foreign, lines: lines(foreignItem, 9) });
  });

  const getPacingAs = (
    who: Member | null,
    outletId = w.outletId,
    host = headers,
  ) =>
    (who?.client ?? agent(app))
      .get(`/api/outlets/${outletId}/kitchen/pacing`)
      .set(host)
      .set(originHeader);

  const getEstimateAs = (
    who: Member | null,
    query: Record<string, string | number>,
    outletId = w.outletId,
    host = headers,
  ) =>
    (who?.client ?? agent(app))
      .get(`/api/outlets/${outletId}/serving-time-estimate`)
      .query(query)
      .set(host)
      .set(originHeader);

  describe("GET /kitchen/pacing", () => {
    it("serves the contract path", () => {
      expect(getPacing.path).toBe("/api/outlets/:outletId/kitchen/pacing");
      expect(estimateServingTimeEndpoint.path).toBe(
        "/api/outlets/:outletId/serving-time-estimate",
      );
    });

    it("KDS-05 answers 200 with the current pacing of the outlet's stations", async () => {
      const res = await getPacingAs(cook);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const snapshot = getPacing.response.parse(res.body).data;
      expect(snapshot).toMatchObject({
        tenantId: w.tenant.tenantId,
        outletId: w.outletId,
      });
      expect(snapshot.stations).toHaveLength(1);
      expect(snapshot.stations[0]).toMatchObject({
        stationId: dapur,
        windowMinutes: 10,
        capacityPoints: 10,
        usedPoints: 6,
        status: "available",
      });
    });

    it("KDS-05 the next read shows a ticket that was just added", async () => {
      await ticket(w, {
        stationId: dapur,
        channel: "dine_in",
        lines: lines(nasi, 2),
      });
      const res = await getPacingAs(cook);
      expect(res.status).toBe(200);
      expect(getPacing.response.parse(res.body).data.stations[0]).toMatchObject(
        {
          usedPoints: 8,
          status: "near_capacity",
        },
      );
    });

    it("KDS-05 an outlet without capacity rules answers 200 with no stations", async () => {
      const res = await getPacingAs(cook, outletB);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(getPacing.response.parse(res.body).data).toMatchObject({
        outletId: outletB,
        stations: [],
      });
    });

    it("answers 401 without a session", async () => {
      expect((await getPacingAs(null)).status).toBe(401);
    });

    it("answers 403 for a role without kds.ticket.process", async () => {
      expect((await getPacingAs(noAccess)).status).toBe(403);
    });

    it("answers 403 for a cook of another outlet", async () => {
      expect((await getPacingAs(outletBCook)).status).toBe(403);
    });

    it("never reaches another tenant's outlet, in either direction", async () => {
      expect([403, 404]).toContain(
        (await getPacingAs(otherCook, w.outletId, headersOther)).status,
      );
      expect([401, 403, 404]).toContain(
        (await getPacingAs(cook, other.outletId, headersOther)).status,
      );
      expect([401, 403, 404]).toContain(
        (await getPacingAs(otherCook, other.outletId, headers)).status,
      );
    });

    it("never shows another tenant's station or queue", async () => {
      const res = await getPacingAs(cook);
      const ids = (res.body.data.stations as { stationId: string }[]).map(
        (s) => s.stationId,
      );
      expect(ids).toEqual([dapur]);
      const theirs = await getPacingAs(otherCook, other.outletId, headersOther);
      expect(theirs.status).toBe(200);
      expect(
        (theirs.body.data.stations as { usedPoints: number }[]).map(
          (s) => s.usedPoints,
        ),
      ).toEqual([9]);
    });
  });

  describe("GET /serving-time-estimate", () => {
    it("KDS-05 answers 200 with an estimate that parses against the contract", async () => {
      const before = Date.now();
      const res = await getEstimateAs(cashier, { channel: "gofood" });
      const after = Date.now();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const estimate = estimateServingTimeEndpoint.response.parse(
        res.body,
      ).data;
      expect(estimate).toMatchObject({
        tenantId: w.tenant.tenantId,
        outletId: w.outletId,
        channel: "gofood",
      });
      // 8 queued points (6 dine_in + 2 gofood) at 1 point per minute plus the
      // 10 minute fallback service time, for the lowest-priority channel.
      expect(estimate.queueLoadPoints).toBe(8);
      expect(estimate.estimatedMinutes).toBe(8 + 10);
      expect(new Date(estimate.computedAt).getTime()).toBeGreaterThanOrEqual(
        before,
      );
      expect(new Date(estimate.computedAt).getTime()).toBeLessThanOrEqual(
        after,
      );
      expect(
        new Date(estimate.estimatedReadyAt).getTime() -
          new Date(estimate.computedAt).getTime(),
      ).toBe(estimate.estimatedMinutes * 60_000);
    });

    it("KDS-05 the top-priority channel waits for less than the others", async () => {
      const dineIn = estimateServingTimeEndpoint.response.parse(
        (await getEstimateAs(cashier, { channel: "dine_in" })).body,
      ).data;
      const gofood = estimateServingTimeEndpoint.response.parse(
        (await getEstimateAs(cashier, { channel: "gofood" })).body,
      ).data;
      expect(dineIn.estimatedMinutes).toBe(6 + 10);
      expect(dineIn.estimatedMinutes).toBeLessThan(gofood.estimatedMinutes);
    });

    it("KDS-05 the estimate follows the queue on the next call", async () => {
      const read = async () =>
        estimateServingTimeEndpoint.response.parse(
          (await getEstimateAs(cashier, { channel: "gofood" })).body,
        ).data.estimatedMinutes;
      const before = await read();
      await ticket(w, {
        stationId: dapur,
        channel: "gofood",
        lines: lines(nasi, 3),
      });
      expect(await read()).toBe(before + 3);
    });

    it("KDS-05 loadPoints is optional and never lowers the estimate", async () => {
      const plain = await getEstimateAs(cashier, { channel: "takeaway" });
      const heavy = await getEstimateAs(cashier, {
        channel: "takeaway",
        loadPoints: 50,
      });
      expect(plain.status).toBe(200);
      expect(heavy.status).toBe(200);
      expect(heavy.body.data.estimatedMinutes).toBeGreaterThanOrEqual(
        plain.body.data.estimatedMinutes,
      );
    });

    it("KDS-05 an outlet without capacity rules answers 200 with the service time only", async () => {
      const res = await getEstimateAs(cashier, { channel: "dine_in" }, outletB);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const estimate = estimateServingTimeEndpoint.response.parse(
        res.body,
      ).data;
      expect(estimate.queueItems).toBe(0);
      expect(estimate.queueLoadPoints).toBe(0);
    });

    it.each([
      ["a missing channel", {}],
      ["an unknown channel", { channel: "telepati" }],
      ["a negative loadPoints", { channel: "gofood", loadPoints: -1 }],
      ["a fractional loadPoints", { channel: "gofood", loadPoints: 1.5 }],
      ["a non-numeric loadPoints", { channel: "gofood", loadPoints: "abc" }],
      ["a loadPoints above 10000", { channel: "gofood", loadPoints: 10_001 }],
    ])("rejects %s with a validation error", async (_label, query) => {
      const res = await getEstimateAs(cashier, query);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
    });

    it("answers 401 without a session", async () => {
      expect((await getEstimateAs(null, { channel: "gofood" })).status).toBe(
        401,
      );
    });

    it("answers 403 for a role with no kitchen, order or POS permission", async () => {
      expect(
        (await getEstimateAs(noAccess, { channel: "gofood" })).status,
      ).toBe(403);
    });

    it("answers 403 for a member of another outlet", async () => {
      expect(
        (await getEstimateAs(outletBCook, { channel: "gofood" })).status,
      ).toBe(403);
    });

    it("never reaches another tenant's outlet, in either direction", async () => {
      const query = { channel: "gofood" };
      expect([403, 404]).toContain(
        (await getEstimateAs(otherCook, query, w.outletId, headersOther))
          .status,
      );
      expect([401, 403, 404]).toContain(
        (await getEstimateAs(cashier, query, other.outletId, headersOther))
          .status,
      );
    });
  });
});

// ---- isolation ---------------------------------------------------------------------

describe("tenant and outlet isolation of the pacing tables", () => {
  let a: World;
  let b: World;
  let outletA2: string;
  let sA: string;
  let sA2: string;
  let sB: string;
  let itemA: string;
  let itemB: string;
  const pauseOf: Record<string, string> = {};
  const loadOf: Record<string, string> = {};
  const stateOfStation: Record<string, string> = {};

  beforeAll(async () => {
    a = await makeWorld("isoa");
    b = await makeWorld("isob");
    outletA2 = await addOutlet(a);
    sA = await station(a, { rules: [rule({ capacityPoints: 100 })] });
    sA2 = await station(a, {
      outletId: outletA2,
      rules: [rule({ capacityPoints: 100 })],
    });
    sB = await station(b, { rules: [rule({ capacityPoints: 100 })] });
    itemA = await item(a, { stationId: sA });
    itemB = await item(b, { stationId: sB });
    await ticket(a, { stationId: sA, lines: lines(itemA, 3) });
    await ticket(a, {
      stationId: sA2,
      outletId: outletA2,
      lines: lines(itemA, 5),
    });
    await ticket(b, { stationId: sB, lines: lines(itemB, 7) });

    await setMenuLoads(
      a.ctx,
      a.outlet,
      [{ menuItemId: itemA, variantId: null, loadPoints: 1, prepSeconds: 100 }],
      NOW,
    );
    await setMenuLoads(
      a.ctx,
      oid(outletA2),
      [{ menuItemId: itemA, variantId: null, loadPoints: 1, prepSeconds: 200 }],
      NOW,
    );
    await setMenuLoads(
      b.ctx,
      b.outlet,
      [{ menuItemId: itemB, variantId: null, loadPoints: 1, prepSeconds: 300 }],
      NOW,
    );
    pauseOf.a = await insertPause(a, {
      menuItemId: itemA,
      channels: ["gofood"],
    });
    pauseOf.a2 = await insertPause(a, {
      menuItemId: itemA,
      channels: ["grabfood"],
      outletId: outletA2,
    });
    pauseOf.b = await insertPause(b, {
      menuItemId: itemB,
      channels: ["gofood"],
    });
    await evaluatePacing(a.ctx, a.outlet, NOW);
    await evaluatePacing(a.ctx, oid(outletA2), NOW);
    await evaluatePacing(b.ctx, b.outlet, NOW);

    const grab = async (
      table: string,
      tenantId: string,
      column: string,
      value: string,
    ) => {
      const { rows } = await owner.query<{ id: string }>(
        `SELECT id::text FROM ${table} WHERE tenant_id = $1 AND ${column} = $2 LIMIT 1`,
        [tenantId, value],
      );
      return rows[0]!.id;
    };
    loadOf.a = await grab(
      "kitchen_menu_loads",
      a.tenant.tenantId,
      "outlet_id",
      a.outletId,
    );
    loadOf.a2 = await grab(
      "kitchen_menu_loads",
      a.tenant.tenantId,
      "outlet_id",
      outletA2,
    );
    loadOf.b = await grab(
      "kitchen_menu_loads",
      b.tenant.tenantId,
      "outlet_id",
      b.outletId,
    );
    stateOfStation.a = await grab(
      "kitchen_pacing_state",
      a.tenant.tenantId,
      "station_id",
      sA,
    );
    stateOfStation.a2 = await grab(
      "kitchen_pacing_state",
      a.tenant.tenantId,
      "station_id",
      sA2,
    );
    stateOfStation.b = await grab(
      "kitchen_pacing_state",
      b.tenant.tenantId,
      "station_id",
      sB,
    );
  });

  /** Either refused or empty: never another tenant's or outlet's rows. */
  const nothing = async <T>(run: Promise<T[]>): Promise<T[]> =>
    run.catch(() => []);

  describe("service", () => {
    it("KDS-05 each outlet's snapshot holds its own stations and queue only", async () => {
      const inA = await pacing(a, NOW);
      expect(inA.stations.map((s) => [s.stationId, s.usedPoints])).toEqual([
        [sA, 3],
      ]);
      const inA2 = await evaluatePacing(a.ctx, oid(outletA2), NOW);
      expect(inA2.stations.map((s) => [s.stationId, s.usedPoints])).toEqual([
        [sA2, 5],
      ]);
      const inB = await pacing(b, NOW);
      expect(inB.stations.map((s) => [s.stationId, s.usedPoints])).toEqual([
        [sB, 7],
      ]);
    });

    it("KDS-05 naming another tenant's outlet never returns its pacing", async () => {
      const crossA = await nothing(
        evaluatePacing(a.ctx, b.outlet, NOW).then((s) => s.stations),
      );
      const crossB = await nothing(
        evaluatePacing(b.ctx, a.outlet, NOW).then((s) => s.stations),
      );
      expect(crossA).toEqual([]);
      expect(crossB).toEqual([]);
    });

    it("KDS-05 menu loads and pauses are listed per tenant and outlet", async () => {
      expect(
        (await listMenuLoads(a.ctx, a.outlet)).map((r) => [
          r.outletId,
          r.prepSeconds,
        ]),
      ).toEqual([[a.outletId, 100]]);
      expect(
        (await listMenuLoads(a.ctx, oid(outletA2))).map((r) => [
          r.outletId,
          r.prepSeconds,
        ]),
      ).toEqual([[outletA2, 200]]);
      expect(
        (await listMenuLoads(b.ctx, b.outlet)).map((r) => r.prepSeconds),
      ).toEqual([300]);
      expect(await nothing(listMenuLoads(a.ctx, b.outlet))).toEqual([]);
      expect(await nothing(listMenuLoads(b.ctx, a.outlet))).toEqual([]);

      expect(
        (await listChannelPauses(a.ctx, a.outlet, NOW)).map((p) => p.id),
      ).toEqual([pauseOf.a]);
      expect(
        (await listChannelPauses(a.ctx, oid(outletA2), NOW)).map((p) => p.id),
      ).toEqual([pauseOf.a2]);
      expect(
        (await listChannelPauses(b.ctx, b.outlet, NOW)).map((p) => p.id),
      ).toEqual([pauseOf.b]);
      expect(await nothing(listChannelPauses(a.ctx, b.outlet, NOW))).toEqual(
        [],
      );
      expect(await nothing(listChannelPauses(b.ctx, a.outlet, NOW))).toEqual(
        [],
      );
    });

    it("KDS-05 the paused lines of one channel read never include another outlet's or tenant's", async () => {
      const inA = await inTx(a, (tx) =>
        readPausedMenuLines(tx, a.ctx, a.outlet, "gofood", NOW),
      );
      expect(inA).toEqual(new Set([lineKey(itemA)]));
      const inA2Grab = await inTx(a, (tx) =>
        readPausedMenuLines(tx, a.ctx, oid(outletA2), "gofood", NOW),
      );
      expect(inA2Grab.size).toBe(0); // outlet A2 paused grabfood, not gofood
      const inB = await inTx(b, (tx) =>
        readPausedMenuLines(tx, b.ctx, b.outlet, "gofood", NOW),
      );
      expect(inB).toEqual(new Set([lineKey(itemB)]));
    });

    it("KDS-05 the station queue read holds the outlet's own stations only", async () => {
      const queue = await inTx(a, (tx) =>
        readStationQueue(tx, a.ctx, a.outlet),
      );
      expect(queue.map((row) => row.stationId)).toEqual([sA]);
      expect(queue[0]!.items.reduce((sum, i) => sum + i.points, 0)).toBe(3);
      const history = await inTx(a, (tx) =>
        readStationHistory(tx, a.ctx, a.outlet, sB, NOW),
      );
      expect(history).toBeNull();
    });

    it("KDS-05 a menu load cannot be written for another tenant's item", async () => {
      await expect(
        setMenuLoads(
          a.ctx,
          a.outlet,
          [
            {
              menuItemId: itemB,
              variantId: null,
              loadPoints: 2,
              prepSeconds: 60,
            },
          ],
          NOW,
        ),
      ).rejects.toThrow();
      const { rows } = await owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM kitchen_menu_loads WHERE tenant_id = $1 AND menu_item_id = $2",
        [a.tenant.tenantId, itemB],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it("KDS-05 another tenant's pause never refuses this tenant's lines", async () => {
      // Tenant B's pause names tenant B's item: tenant A's read stays unaffected.
      const set = await inTx(a, (tx) =>
        readPausedMenuLines(tx, a.ctx, a.outlet, "gofood", NOW),
      );
      expect(set.has(lineKey(itemB))).toBe(false);
    });
  });

  describe("legend_app role (RLS)", () => {
    const tables = [
      {
        table: "kitchen_menu_loads",
        updateSet: "load_points = load_points",
        ids: () => loadOf,
      },
      {
        table: "kitchen_channel_pauses",
        updateSet: "reason = reason",
        ids: () => pauseOf,
      },
      {
        table: "kitchen_pacing_state",
        updateSet: "used_points = used_points",
        ids: () => stateOfStation,
      },
    ];

    it.each(tables)(
      "each tenant sees, changes and deletes only its own $table rows",
      async ({ table, updateSet, ids }) => {
        const rows = ids();
        await expectRowsIsolated(
          appPool,
          {
            table,
            updateSet,
            tenantA: { tenantId: a.tenant.tenantId, rowId: rows.a! },
            tenantB: { tenantId: b.tenant.tenantId, rowId: rows.b! },
          },
          owner,
        );
      },
    );

    it.each(tables)(
      "a session scoped to one outlet sees only that outlet's $table rows",
      async ({ table }) => {
        const count = (outletIds: "*" | string[]) =>
          asTenant(
            appPool,
            a.tenant.tenantId,
            async (client) => {
              const { rows } = await client.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM ${table}`,
              );
              return Number(rows[0]!.n);
            },
            outletIds,
          );
        const owned = async (outletId: string) => {
          const { rows } = await owner.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1 AND outlet_id = $2`,
            [a.tenant.tenantId, outletId],
          );
          return Number(rows[0]!.n);
        };
        const inA = await owned(a.outletId);
        const inA2 = await owned(outletA2);
        expect(inA).toBeGreaterThan(0);
        expect(inA2).toBeGreaterThan(0);
        expect(await count([a.outletId])).toBe(inA);
        expect(await count([outletA2])).toBe(inA2);
        expect(await count("*")).toBe(inA + inA2);
        expect(await count([randomUUID()])).toBe(0);
      },
    );

    const inserts: {
      table: string;
      sql: string;
      params: (outletId: string, tenantId: string) => unknown[];
    }[] = [
      {
        table: "kitchen_menu_loads",
        sql: `INSERT INTO kitchen_menu_loads (tenant_id, outlet_id, menu_item_id, variant_id, load_points, prep_seconds)
              VALUES ($1, $2, $3, NULL, 1, 60)`,
        params: (outletId, tenantId) => [
          tenantId,
          outletId,
          tenantId === a.tenant.tenantId ? itemA : itemB,
        ],
      },
      {
        table: "kitchen_channel_pauses",
        sql: `INSERT INTO kitchen_channel_pauses (tenant_id, outlet_id, menu_item_id, channels, reason)
              VALUES ($1, $2, $3, '["gofood"]'::jsonb, 'manual')`,
        params: (outletId, tenantId) => [
          tenantId,
          outletId,
          tenantId === a.tenant.tenantId ? itemA : itemB,
        ],
      },
      {
        table: "kitchen_pacing_state",
        sql: `INSERT INTO kitchen_pacing_state (tenant_id, outlet_id, station_id, level, used_points, window_start, changed_at, evaluated_at)
              VALUES ($1, $2, $3, 'available', 0, now(), now(), now())`,
        params: (outletId, tenantId) => [
          tenantId,
          outletId,
          tenantId === a.tenant.tenantId ? sA2 : sB,
        ],
      },
    ];

    it.each(inserts)(
      "refuses a $table write outside the session's outlet or tenant",
      async ({ sql, params }) => {
        // Scoped to outlet A: a row for outlet A2 is outside the scope.
        await expect(
          asTenant(
            appPool,
            a.tenant.tenantId,
            (client) => client.query(sql, params(outletA2, a.tenant.tenantId)),
            [a.outletId],
          ),
        ).rejects.toThrow(/row-level security/);
        // Tenant A's session writing a tenant B row.
        await expect(
          asTenant(
            appPool,
            a.tenant.tenantId,
            (client) =>
              client.query(sql, params(b.outletId, b.tenant.tenantId)),
            "*",
          ),
        ).rejects.toThrow(/row-level security/);
      },
    );
  });
});

// ---- D2: auto-pause only for lines with an explicit menu load row ------------------

describe("D2 auto-pause only pauses lines with an explicit kitchen_menu_loads row (KDS-05)", () => {
  // Decision D2: a menu line WITHOUT a kitchen_menu_loads row (exact variant or
  // item level) is never auto-paused, whatever the station's default prep time
  // is (station target or the 600 s fallback). Only a recorded prepSeconds
  // >= LONG_PREP_SECONDS pauses. Load points (1) and the ETA default stay.
  let w: World;
  let dapur: string; // station target 900 s: a default prep above the threshold
  let kedai: string; // no target: the 600 s fallback equals the threshold
  let withRow: string; // item row, 1200 s
  let noRow: string; // no row at all, on the 900 s station
  let noRowVariantItem: string; // no item row ...
  let noRowVariant: string; // ... and no variant row
  let inheritedVariant: string; // no own row, item row 1200 s: inherits it
  let inheritingItem: string;
  let kedaiNoRow: string; // no row on the no-target station
  let kedaiWithRow: string;

  beforeAll(async () => {
    w = await makeWorld("d2");
    const fill = (stationId: string) =>
      station(w, {
        targetSeconds: stationId === "dapur" ? 900 : null,
        rules: [
          rule({
            windowMinutes: 10,
            capacityPoints: 10,
            channelPriority: ["dine_in", "gofood"],
          }),
        ],
      });
    dapur = await fill("dapur");
    kedai = await fill("kedai");
    withRow = await item(w, {
      stationId: dapur,
      load: { points: 1, prep: 1200 },
    });
    noRow = await item(w, { stationId: dapur });
    noRowVariantItem = await item(w, { stationId: dapur });
    noRowVariant = await variant(w, noRowVariantItem);
    inheritingItem = await item(w, {
      stationId: dapur,
      load: { points: 1, prep: 1200 },
    });
    inheritedVariant = await variant(w, inheritingItem);
    kedaiNoRow = await item(w, { stationId: kedai });
    kedaiWithRow = await item(w, {
      stationId: kedai,
      load: { points: 1, prep: LONG_PREP_SECONDS },
    });
    // Both stations exactly at capacity (10 of 10) with default one-point lines.
    await ticket(w, {
      stationId: dapur,
      lines: [
        { itemId: withRow },
        { itemId: noRow },
        { itemId: noRowVariantItem, variantId: noRowVariant },
        { itemId: inheritingItem, variantId: inheritedVariant },
        ...lines(noRow, 6),
      ],
    });
    await ticket(w, {
      stationId: kedai,
      lines: [
        { itemId: kedaiWithRow },
        { itemId: kedaiNoRow },
        ...lines(kedaiNoRow, 8),
      ],
    });
  });

  const pausedFor = (channel: string, now: Date) =>
    inTx(w, (tx) => readPausedMenuLines(tx, w.ctx, w.outlet, channel, now));

  it("KDS-05 both stations are at capacity, lines without a row still count one point", async () => {
    const snapshot = await pacing(w, NOW);
    expect(stationOf(snapshot, dapur)).toMatchObject({
      usedPoints: 10,
      status: "at_capacity",
    });
    expect(stationOf(snapshot, kedai)).toMatchObject({
      usedPoints: 10,
      status: "at_capacity",
    });
  });

  it("KDS-05 a line with no menu load row is never auto-paused, even when the station default prep is long", async () => {
    await pacing(w, NOW);
    const live = liveAuto(await pauseRows(w)).map((r) =>
      lineKey(r.menu_item_id, r.variant_id),
    );
    expect(live).not.toContain(lineKey(noRow));
    expect(live).not.toContain(lineKey(noRowVariantItem));
    expect(live).not.toContain(lineKey(noRowVariantItem, noRowVariant));
    expect(live).not.toContain(lineKey(kedaiNoRow));
    const paused = await pausedFor("gofood", NOW);
    expect(isLinePaused(paused, noRow, null)).toBe(false);
    expect(isLinePaused(paused, noRowVariantItem, null)).toBe(false);
    expect(isLinePaused(paused, noRowVariantItem, noRowVariant)).toBe(false);
    expect(isLinePaused(paused, kedaiNoRow, null)).toBe(false);
  });

  it("KDS-05 only lines with a recorded prep of at least the threshold are paused", async () => {
    await pacing(w, NOW);
    const live = liveAuto(await pauseRows(w)).map((r) =>
      lineKey(r.menu_item_id, r.variant_id),
    );
    // The item row, the variant that inherits the item row, and the item row
    // at exactly the threshold on the other station. Nothing else.
    expect(new Set(live)).toEqual(
      new Set([
        lineKey(withRow),
        lineKey(inheritingItem, inheritedVariant),
        lineKey(kedaiWithRow),
      ]),
    );
    const paused = await pausedFor("gofood", NOW);
    expect(isLinePaused(paused, withRow, null)).toBe(true);
    expect(isLinePaused(paused, inheritingItem, inheritedVariant)).toBe(true);
    expect(isLinePaused(paused, kedaiWithRow, null)).toBe(true);
    // The first channel is never paused.
    expect((await pausedFor("dine_in", NOW)).size).toBe(0);
  });
});

// ---- D4: GET /kitchen/pacing for station-scoped cooks -------------------------------

describe("D4 GET /kitchen/pacing is readable by station-scoped cooks, their stations only (KDS-05)", () => {
  // Decision D4: the route needs `kds.ticket.process` like /station-summary.
  // A station-scoped cook sees only their permitted stations, an outlet-wide
  // holder sees all, a cook whose station has nothing to show gets 200 with
  // `stations: []` (not 403). /serving-time-estimate stays `order.view`.
  // Assumption: "no permitted station" is set up as a cook scoped to a station
  // that has no capacity rule (the snapshot has no row for it), since a cook
  // scoped to a station of another outlet cannot reach this outlet at all.
  let w: World;
  let headers: { Host: string };
  let grill: string;
  let bar: string;
  let pastry: string;
  let grillCook: Member;
  let barCook: Member;
  let pastryCook: Member;
  let wideCook: Member;
  let outletCook: Member;
  let noAccess: Member;

  beforeAll(async () => {
    w = await makeWorld("d4");
    headers = { Host: w.tenant.hostname };
    const cookRole = await insertRole(
      w.tenant.tenantId,
      "Koki Stasiun D4",
      ["kds.ticket.process"],
      ["tenant", "outlet", "station"],
    );
    const noRole = await insertRole(
      w.tenant.tenantId,
      "Tanpa KDS D4",
      ["floor.table.view"],
      ["tenant"],
    );
    grill = await station(w, {
      name: "Grill D4",
      rules: [
        rule({
          windowMinutes: 10,
          capacityPoints: 10,
          schedule: scheduleAroundNow(),
        }),
      ],
    });
    // A distinctive capacity (77) to prove another station's numbers never leak.
    bar = await station(w, {
      name: "Bar D4",
      type: "beverage_bar",
      rules: [
        rule({
          windowMinutes: 20,
          capacityPoints: 77,
          schedule: scheduleAroundNow(),
        }),
      ],
    });
    pastry = await station(w, { name: "Pastry D4", type: "pastry", rules: [] });
    const nasi = await item(w, { stationId: grill });
    const teh = await item(w, { stationId: bar });
    await ticket(w, { stationId: grill, lines: lines(nasi, 6) });
    await ticket(w, { stationId: bar, lines: lines(teh, 3) });
    const at = (label: string, scope: Parameters<typeof member>[3]) =>
      member(app, w.tenant.tenantId, cookRole, scope, label);
    grillCook = await at("D4 Koki Grill", { type: "station", id: grill });
    barCook = await at("D4 Koki Bar", { type: "station", id: bar });
    pastryCook = await at("D4 Koki Pastry", { type: "station", id: pastry });
    wideCook = await at("D4 Koki Tenant", { type: "tenant", id: null });
    outletCook = await at("D4 Koki Outlet", {
      type: "outlet",
      id: w.outletId,
    });
    noAccess = await member(
      app,
      w.tenant.tenantId,
      noRole,
      { type: "tenant", id: null },
      "D4 Tanpa KDS",
    );
  });

  const read = (who: Member | null) =>
    (who?.client ?? agent(app))
      .get(`/api/outlets/${w.outletId}/kitchen/pacing`)
      .set(headers)
      .set(originHeader);

  const stationIds = (body: unknown) =>
    getPacing.response
      .parse(body)
      .data.stations.map((s) => s.stationId)
      .sort();

  it("KDS-05 a cook scoped to one station reads that station's pacing only", async () => {
    const res = await read(grillCook);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(stationIds(res.body)).toEqual([grill]);
    const [row] = getPacing.response.parse(res.body).data.stations;
    expect(row).toMatchObject({
      stationId: grill,
      windowMinutes: 10,
      capacityPoints: 10,
      usedPoints: 6,
    });
  });

  it("KDS-05 the other station's id and numbers never appear in a station cook's response", async () => {
    const res = await read(grillCook);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(bar);
    expect(text).not.toContain(pastry);
    expect(text).not.toContain('"capacityPoints":77');
    expect(text).not.toContain('"windowMinutes":20');
  });

  it("KDS-05 a cook of the other station sees that one instead", async () => {
    const res = await read(barCook);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(stationIds(res.body)).toEqual([bar]);
    expect(getPacing.response.parse(res.body).data.stations[0]).toMatchObject({
      capacityPoints: 77,
      usedPoints: 3,
    });
    expect(JSON.stringify(res.body)).not.toContain(grill);
  });

  it("KDS-05 a tenant-wide and an outlet-wide cook read every station of the outlet", async () => {
    for (const who of [wideCook, outletCook]) {
      const res = await read(who);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(stationIds(res.body)).toEqual([bar, grill].sort());
    }
  });

  it("KDS-05 a station cook with nothing to show gets 200 and no stations, not 403", async () => {
    const res = await read(pastryCook);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(getPacing.response.parse(res.body).data).toMatchObject({
      tenantId: w.tenant.tenantId,
      outletId: w.outletId,
      stations: [],
    });
  });

  it("KDS-05 a role without kds.ticket.process still gets 403 and an anonymous caller 401", async () => {
    expect((await read(noAccess)).status).toBe(403);
    expect((await read(null)).status).toBe(401);
  });

  it("KDS-06 /serving-time-estimate stays closed to a cook without order.view", async () => {
    const res = await grillCook.client
      .get(`/api/outlets/${w.outletId}/serving-time-estimate`)
      .query({ channel: "dine_in" })
      .set(headers)
      .set(originHeader);
    expect(res.status).toBe(403);
  });
});
