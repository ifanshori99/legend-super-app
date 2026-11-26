// 1271 F3 cloud failover window: service, routes and the POS write gate
// (docs/briefs/1271-edge-failover-cards.md D2, D4, D6; CTO 27 Nov: append-only
// switchover counts, core-path allowlist, default refuse; F2 review no. 4: the
// gate and the transitions lock the window row, so no sale straddles a
// transition). "Jangan sampai rugi": edge and cloud never sell at once, a
// window that touched money ends only through the return, whose closing event
// carries each device's switchover count once.
//
// One outlet with an active primary edge, walked through its windows in
// order (each `it` builds on the previous one).
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { startFailoverReturn } from "../services/edge-failover.service.ts";
import {
  posWriteFailoverWindowId,
  setPosWriteGateEdgeModeForTests,
} from "../services/pos-edge-outlet.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  waitForLockWaiters,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const flag = env as unknown as { EDGE_FAILOVER_ENABLED?: boolean };
const flagWas = flag.EDGE_FAILOVER_ENABLED;

const ids = {
  managerRole: randomUUID(),
  supervisorRole: randomUUID(),
  ownerRole: randomUUID(),
  cashierRole: randomUUID(),
  device: randomUUID(),
  edge: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
};
const COUNT_C1 = [
  { denominationIdr: 100_000, quantity: 9 },
  { denominationIdr: 50_000, quantity: 1 },
  { denominationIdr: 20_000, quantity: 2 },
];
const C1_IDR = 990_000;

type Person = { client: ReturnType<typeof agent>; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let manager: Person;
let supervisor: Person;
let cashier: Person;
let ownerUser: Person;
// The windows the walk opens.
let cancelledId: string;
let windowId: string;
let failoverShiftId: string;
let failoverOrderId: string;

const windows = "/api/edge-failover/windows";
const key = () => randomUUID();

function context() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function send(person: Person, path: string, body: object) {
  return person.client.post(path).set(headers).set(originHeader).send(body);
}

function read(person: Person, path: string) {
  return person.client.get(path).set(headers).set(originHeader);
}

async function heartbeat(secondsAgo: number): Promise<void> {
  await owner.query(
    `UPDATE edge_nodes SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [ids.edge, secondsAgo],
  );
}

/** The gate as a core (or default) write of the outlet, in its own transaction. */
function gate(options: Parameters<typeof posWriteFailoverWindowId>[3] = {}) {
  return withTenant(db, context(), (tx) =>
    posWriteFailoverWindowId(
      tx,
      tenant.tenantId as TenantId,
      tenant.outletId as OutletId,
      options,
    ),
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

function deviceToken(): string {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: ids.device,
  });
}

/** A cashier POS write of the outlet over HTTP (device-signed). */
function pos(path: string, body: object) {
  return cashier.client
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos${path}`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({ idempotencyKey: key(), ...body });
}

function createOrder() {
  return pos("/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
  });
}

/** Open a window on a dead edge, with a failover shift and one unpaid order. */
async function windowWithSale(reason: string) {
  await heartbeat(600);
  const opened = await send(manager, windows, {
    outletId: tenant.outletId,
    reason,
    idempotencyKey: key(),
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const shift = await openPosShift(
    context(),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    {
      openingFloatIdr: idr(C1_IDR),
      openingCounts: COUNT_C1,
      idempotencyKey: key(),
    },
  );
  const order = await createOrder();
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  return {
    id: opened.body.data.id as string,
    shiftId: shift.id as string,
    orderId: order.body.data.id as string,
  };
}

async function queued(window: string) {
  const { rows } = await owner.query<{
    name: string;
    kind: string;
    sequence: number;
    event_id: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT event->>'name' AS name, kind, aggregate_sequence::int AS sequence, event_id::text,
            event->'payload' AS payload
       FROM edge_outbound_queue
      WHERE tenant_id = $1 AND direction = 'cloud_to_edge'
        AND aggregate_type = 'pos_failover_window' AND aggregate_id = $2
      ORDER BY aggregate_sequence`,
    [tenant.tenantId, window],
  );
  return rows;
}

async function audits(window: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 ORDER BY created_at, id`,
    [tenant.tenantId, window],
  );
  return rows.map((row) => row.action);
}

async function person(name: string, roleId: string): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

async function role(
  id: string,
  name: string,
  templateKey: string | null,
  permissions: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5, $6, false, '["tenant"]')`,
    [
      id,
      tenant.tenantId,
      name,
      templateKey !== null,
      templateKey,
      JSON.stringify(permissions),
    ],
  );
}

async function seedCatalogue(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Failover Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, manager.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-FO', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, manager.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Close a failover shift the way a supervisor close leaves it (count + approval). */
async function closeShift(shiftId: string, countedIdr: number): Promise<void> {
  const countId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shift_counts
       (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
        counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, $6, $6, 0, $7, now(), false, $8, $5)`,
    [
      countId,
      tenant.tenantId,
      tenant.outletId,
      shiftId,
      "b".repeat(64),
      countedIdr,
      cashier.userId,
      randomUUID(),
    ],
  );
  await owner.query(
    `UPDATE pos_shifts SET status = 'closed', expected_idr = $3, counted_idr = $3,
        variance_idr = 0, counts = '[]'::jsonb, count_id = $4,
        approved_by = $5, approval_request_id = $6, approval_override_id = $7,
        approved_at = now(), closed_at = now(), closed_by = $8, close_key = $9,
        close_fingerprint = $10, version = version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [
      tenant.tenantId,
      shiftId,
      countedIdr,
      countId,
      manager.userId,
      randomUUID(),
      randomUUID(),
      cashier.userId,
      randomUUID(),
      "c".repeat(64),
    ],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`fo-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await role(ids.managerRole, "Manajer Failover", null, [
    "pos.failover.manage",
    "shift.cash.operate",
  ]);
  await role(ids.supervisorRole, "Supervisor", "supervisor", [
    "pos.failover.manage",
  ]);
  await role(ids.ownerRole, "Owner", "owner", []);
  await role(ids.cashierRole, "Kasir Failover", null, [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "shift.cash.operate",
  ]);
  manager = await person("Manajer Failover", ids.managerRole);
  supervisor = await person("Supervisor Failover", ids.supervisorRole);
  ownerUser = await person("Owner Failover", ids.ownerRole);
  cashier = await person("Kasir Failover", ids.cashierRole);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Failover', now() - interval '1 minute')`,
    [ids.device, tenant.tenantId, tenant.outletId],
  );
  setDeviceOutletResolver(async (input) =>
    input.tenantId === tenant.tenantId && input.deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, last_heartbeat_at)
     VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, now())`,
    [ids.edge, tenant.tenantId, tenant.outletId, "f".repeat(64)],
  );
  await seedCatalogue();
}, 120_000);

afterAll(async () => {
  flag.EDGE_FAILOVER_ENABLED = flagWas;
  setPosWriteGateEdgeModeForTests(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("1271 F3 failover window", () => {
  it("D6: with the flag off activation is 403 FAILOVER_DISABLED and writes nothing", async () => {
    flag.EDGE_FAILOVER_ENABLED = false;
    await heartbeat(600);
    const response = await send(manager, windows, {
      outletId: tenant.outletId,
      reason: "Server lokal mati",
      idempotencyKey: key(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("FAILOVER_DISABLED");
    const { rows } = await owner.query(
      "SELECT 1 FROM outlet_failover_windows WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    expect(rows).toHaveLength(0);
    flag.EDGE_FAILOVER_ENABLED = true;
  });

  it("a cashier without pos.failover.manage gets 403", async () => {
    const response = await send(cashier, windows, {
      outletId: tenant.outletId,
      reason: "Server lokal mati",
      idempotencyKey: key(),
    });
    expect(response.status).toBe(403);
  });

  it("a fresh heartbeat is refused; an override with a reason opens it and notifies the owner", async () => {
    await heartbeat(5);
    const refused = await send(manager, windows, {
      outletId: tenant.outletId,
      reason: "Server lokal mati",
      idempotencyKey: key(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("FAILOVER_EDGE_HEALTHY");
    const noReason = await send(manager, windows, {
      outletId: tenant.outletId,
      override: true,
      idempotencyKey: key(),
    });
    expect(noReason.status).toBe(422);
    const opened = await send(manager, windows, {
      outletId: tenant.outletId,
      reason: "Switch LAN mati, server lokal hidup",
      override: true,
      idempotencyKey: key(),
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data).toMatchObject({
      status: "active",
      override: true,
      edgeNodeId: ids.edge,
      activatedBy: manager.userId,
    });
    cancelledId = opened.body.data.id as string;
    const notified = await owner.query<{ user_id: string }>(
      "SELECT user_id FROM notifications WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    expect(notified.rows.map((row) => row.user_id)).toContain(ownerUser.userId);
    expect(await audits(cancelledId)).toEqual(["edge.failover.activated"]);
    const events = await queued(cancelledId);
    expect(
      events.map((event) => [event.name, event.kind, event.sequence]),
    ).toEqual([["pos_failover_window.state", "master_data", 1]]);
  });

  it("cancel with no failover order or shift: cancelled, the edge is told, a retry is the same answer", async () => {
    const cancelled = await send(manager, `${windows}/${cancelledId}/cancel`, {
      reason: "Salah tekan",
      idempotencyKey: key(),
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    const again = await send(manager, `${windows}/${cancelledId}/cancel`, {
      reason: "Salah tekan",
      idempotencyKey: key(),
    });
    expect(again.body.data).toEqual(cancelled.body.data);
    const events = await queued(cancelledId);
    expect(events.map((event) => [event.name, event.sequence])).toEqual([
      ["pos_failover_window.state", 1],
      ["pos_failover_window.state", 2],
      ["pos_failover_window.closed", 3],
    ]);
    expect(events[2]!.payload).toMatchObject({
      windowId: cancelledId,
      status: "cancelled",
      shifts: [],
    });
    const { rows } = await owner.query<{ closing: string }>(
      "SELECT closing_event_id::text AS closing FROM outlet_failover_windows WHERE id = $1",
      [cancelledId],
    );
    expect(rows[0]!.closing).toBe(events[2]!.event_id);
  });

  it("a supervisor opens on a stale heartbeat; the same key replays, another key is FAILOVER_ACTIVE", async () => {
    await heartbeat(600);
    const idempotencyKey = key();
    const body = {
      outletId: tenant.outletId,
      reason: "Server lokal mati total",
      idempotencyKey,
    };
    const opened = await send(supervisor, windows, body);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data.override).toBe(false);
    windowId = opened.body.data.id as string;
    const replay = await send(supervisor, windows, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(opened.body.data);
    const other = await send(manager, windows, {
      ...body,
      idempotencyKey: key(),
    });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("FAILOVER_ACTIVE");
  });

  it("D4 gate while active: only core writes pass, only on rows of the window; flag off and the edge refuse", async () => {
    expect(await gate({ failover: "core" })).toBe(windowId);
    expect(await codeOf(gate())).toBe("POS_WRITE_ON_EDGE");
    // An edge shift mirrored up (no window) stays the edge's.
    const edgeShift = randomUUID();
    await owner.query(
      `INSERT INTO pos_shifts (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
         opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, '2026-11-20', 'open', now(), 0, $6, $7)`,
      [
        edgeShift,
        tenant.tenantId,
        tenant.outletId,
        randomUUID(),
        cashier.userId,
        `edge:${randomUUID()}`,
        "d".repeat(64),
      ],
    );
    expect(
      await codeOf(
        gate({ failover: "core", target: { kind: "shift", id: edgeShift } }),
      ),
    ).toBe("POS_WRITE_ON_EDGE");
    await closeShift(edgeShift, 0);
    flag.EDGE_FAILOVER_ENABLED = false;
    expect(await codeOf(gate({ failover: "core" }))).toBe("POS_WRITE_ON_EDGE");
    flag.EDGE_FAILOVER_ENABLED = true;
    setPosWriteGateEdgeModeForTests(() => true);
    try {
      expect(await codeOf(gate({ failover: "core" }))).toBe("FAILOVER_ACTIVE");
      expect(await codeOf(gate())).toBe("FAILOVER_ACTIVE");
    } finally {
      setPosWriteGateEdgeModeForTests(null);
    }
  });

  it("D2: the failover shift opens only with the switchover count, stamped with the window", async () => {
    const caller = {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: ids.device,
    };
    const outletId = outletIdSchema.parse(tenant.outletId);
    expect(
      await codeOf(
        openPosShift(context(), caller, outletId, {
          openingFloatIdr: idr(C1_IDR),
          idempotencyKey: key(),
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      await codeOf(
        openPosShift(context(), caller, outletId, {
          openingFloatIdr: idr(C1_IDR + 1000),
          openingCounts: COUNT_C1,
          idempotencyKey: key(),
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    const shift = await openPosShift(context(), caller, outletId, {
      openingFloatIdr: idr(C1_IDR),
      openingCounts: COUNT_C1,
      idempotencyKey: key(),
    });
    failoverShiftId = shift.id;
    const { rows } = await owner.query<{ window: string }>(
      "SELECT failover_window_id::text AS window FROM pos_shifts WHERE id = $1",
      [shift.id],
    );
    expect(rows[0]!.window).toBe(windowId);
    const counts = await owner.query(
      `SELECT device_id::text, shift_id::text, cashier_id, total_idr::int, counts
         FROM outlet_failover_switchover_counts WHERE window_id = $1`,
      [windowId],
    );
    expect(counts.rows).toEqual([
      {
        device_id: ids.device,
        shift_id: shift.id,
        cashier_id: cashier.userId,
        total_idr: C1_IDR,
        counts: COUNT_C1,
      },
    ]);
    await expect(
      owner.query(
        "UPDATE outlet_failover_switchover_counts SET total_idr = 0 WHERE window_id = $1",
        [windowId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("a cashier order in the cloud carries the window; a strict write stays refused over HTTP", async () => {
    const token = deviceToken();
    const created = await createOrder();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    failoverOrderId = created.body.data.id as string;
    const { rows } = await owner.query<{ window: string }>(
      `SELECT failover_window_id::text AS window FROM pos_orders
        WHERE tenant_id = $1 AND failover_window_id IS NOT NULL`,
      [tenant.tenantId],
    );
    expect(rows.map((row) => row.window)).toEqual([windowId]);
    const strict = await cashier.client
      .put(`/api/pos/orders/${encodeURIComponent(failoverOrderId)}/customer`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .send({});
    expect(strict.body.error?.code).toBe("POS_WRITE_ON_EDGE");
  });

  it("cancel is refused once the window holds an order or a shift", async () => {
    const response = await send(manager, `${windows}/${windowId}/cancel`, {
      reason: "Salah tekan",
      idempotencyKey: key(),
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("FAILOVER_OPEN_WORK");
    // Review K F3 P3: every order of the window, paid or not, as `orderIds`.
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        { field: "orderIds", message: failoverOrderId },
        { field: "openShiftIds", message: failoverShiftId },
      ]),
    );
    expect(
      (response.body.error.details as { field: string }[]).some(
        (detail) => detail.field === "unpaidOrderIds",
      ),
    ).toBe(false);
  });

  it("return is refused while the edge is silent, then lists the open work", async () => {
    const silent = await send(manager, `${windows}/${windowId}/return`, {
      idempotencyKey: key(),
    });
    expect(silent.status).toBe(409);
    expect(silent.body.error.code).toBe("FAILOVER_EDGE_OFFLINE");
    await heartbeat(5);
    const open = await send(manager, `${windows}/${windowId}/return`, {
      idempotencyKey: key(),
    });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe("FAILOVER_OPEN_WORK");
    expect(open.body.error.details).toEqual(
      expect.arrayContaining([
        { field: "unpaidOrderIds", message: failoverOrderId },
        { field: "openShiftIds", message: failoverShiftId },
      ]),
    );
  });

  it("review K F3 P3: a cloud cart parked in the window blocks the return until resumed", async () => {
    // The cart's own contract is not under test: park the row directly.
    const parkedId = randomUUID();
    await owner.query(
      `INSERT INTO pos_parked_orders
         (id, tenant_id, outlet_id, creator_user_id, idempotency_key, request_hash, snapshot, label)
       VALUES ($1, $2, $3, $4, $5, $6, '{"items":[]}'::jsonb, 'Meja depan')`,
      [
        parkedId,
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        key(),
        "e".repeat(64),
      ],
    );
    const open = await send(manager, `${windows}/${windowId}/return`, {
      idempotencyKey: key(),
    });
    expect(open.body.error.details).toEqual(
      expect.arrayContaining([{ field: "parkedOrderIds", message: parkedId }]),
    );
    const resumed = await pos(
      `/parked-orders/${encodeURIComponent(parkedId)}/resume`,
      {},
    );
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  });

  it("F2 review no. 4: a sale holding the gate makes the return wait; then the return closes with C1", async () => {
    await owner.query(
      "UPDATE orders SET status = 'voided' WHERE tenant_id = $1 AND id = (SELECT order_id FROM pos_orders WHERE tenant_id = $1 AND failover_window_id = $2)",
      [tenant.tenantId, windowId],
    );
    await closeShift(failoverShiftId, C1_IDR);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gateOpened!: (value: string | null) => void;
    const opened = new Promise<string | null>((resolve) => {
      gateOpened = resolve;
    });
    const sale = withTenant(db, context(), async (tx) => {
      gateOpened(
        await posWriteFailoverWindowId(
          tx,
          tenant.tenantId as TenantId,
          tenant.outletId as OutletId,
          { failover: "core" },
        ),
      );
      await held;
    });
    expect(await opened).toBe(windowId);
    let returned = false;
    const returning = startFailoverReturn(
      context(),
      { userId: manager.userId },
      windowId,
      { idempotencyKey: key() },
    ).then((window) => {
      returned = true;
      return window;
    });
    await waitForLockWaiters(1);
    expect(returned).toBe(false);
    release();
    await sale;
    const window = await returning;
    expect(window.status).toBe("returning");
    expect(await codeOf(gate({ failover: "core" }))).toBe("POS_WRITE_ON_EDGE");
    const events = await queued(windowId);
    const closing = events.at(-1)!;
    expect(closing.name).toBe("pos_failover_window.closed");
    expect(closing.payload).toMatchObject({
      windowId,
      status: "closed",
      shifts: [
        {
          deviceId: ids.device,
          cashierId: cashier.userId,
          counts: COUNT_C1,
          totalIdr: C1_IDR,
        },
      ],
    });
  });

  it("the return finishes once the edge acks the closing event (GET and retry)", async () => {
    const before = await read(manager, `${windows}/${windowId}`);
    expect(before.body.data.status).toBe("returning");
    await owner.query(
      `UPDATE sync_cursors SET acked_out_seq = next_out_seq
        WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
      [ids.edge],
    );
    const after = await read(manager, `${windows}/${windowId}`);
    expect(after.status).toBe(200);
    expect(after.body.data.status).toBe("closed");
    expect(await audits(windowId)).toEqual(
      expect.arrayContaining([
        "edge.failover.activated",
        "edge.failover.return_started",
        "edge.failover.closed",
      ]),
    );
    const retry = await send(manager, `${windows}/${windowId}/return`, {
      idempotencyKey: key(),
    });
    expect(retry.body.data.status).toBe("closed");
    expect(await codeOf(gate({ failover: "core" }))).toBe("POS_WRITE_ON_EDGE");
  });

  it("review K F3 P2 no. 1: with the switch off mid-window nothing new is sold, the window's rows still finish and the return goes through", async () => {
    const window = await windowWithSale("Server lokal mati, uji saklar");
    flag.EDGE_FAILOVER_ENABLED = false;
    try {
      const created = await createOrder();
      expect(created.body.error?.code).toBe("POS_WRITE_ON_EDGE");
      expect(await codeOf(gate({ failover: "core" }))).toBe("POS_WRITE_ON_EDGE");
      expect(
        await gate({
          failover: "finish",
          target: { kind: "shift", id: window.shiftId },
        }),
      ).toBe(window.id);
      // Finishing paths pass the gate (they fail on their own rules here).
      const close = await pos(`/shifts/${window.shiftId}/close`, {});
      expect(close.body.error?.code).not.toBe("POS_WRITE_ON_EDGE");
      expect(close.status).not.toBe(403);
      const complete = await pos(`/orders/${window.orderId}/complete`, {
        expectedStatus: "awaiting_payment",
      });
      expect(complete.body.error?.code).not.toBe("POS_WRITE_ON_EDGE");
      expect(complete.status).not.toBe(403);
      await owner.query(
        "UPDATE orders SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, window.orderId],
      );
      await closeShift(window.shiftId, C1_IDR);
      await heartbeat(5);
      const returned = await send(manager, `${windows}/${window.id}/return`, {
        idempotencyKey: key(),
      });
      expect(returned.status, JSON.stringify(returned.body)).toBe(200);
      expect(returned.body.data.status).toBe("returning");
      await owner.query(
        `UPDATE sync_cursors SET acked_out_seq = next_out_seq
          WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
        [ids.edge],
      );
      const closed = await read(manager, `${windows}/${window.id}`);
      expect(closed.body.data.status).toBe("closed");
    } finally {
      flag.EDGE_FAILOVER_ENABLED = true;
    }
  });

  it("F2 review no. 4 + review K F3 P2 no. 2: a transition holding the window makes a sale and a refund wait, then refuses both", async () => {
    const window = await windowWithSale("Server lokal mati lagi");
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM outlet_failover_windows WHERE id = $1 FOR UPDATE",
        [window.id],
      );
      await client.query(
        `UPDATE outlet_failover_windows SET status = 'returning', return_started_at = now(),
           return_started_by = $2, business_date_to = business_date_from,
           closing_event_id = gen_random_uuid()
         WHERE id = $1`,
        [window.id, manager.userId],
      );
      const sale = codeOf(gate({ failover: "core" }));
      const refund = codeOf(
        refundPosOrder(
          context(),
          {
            userId: userIdSchema.parse(cashier.userId),
            deviceId: ids.device,
          },
          outletIdSchema.parse(tenant.outletId),
          window.orderId,
          {
            idempotencyKey: key(),
          } as unknown as Parameters<typeof refundPosOrder>[4],
        ),
      );
      await waitForLockWaiters(2);
      await client.query("COMMIT");
      expect(await sale).toBe("POS_WRITE_ON_EDGE");
      expect(await refund).toBe("POS_WRITE_ON_EDGE");
    } finally {
      client.release();
    }
  });
});
