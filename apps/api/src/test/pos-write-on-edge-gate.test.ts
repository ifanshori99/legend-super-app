// 1269 E3 cloud write gate over HTTP: an outlet with an active edge node
// (primary or standby only) sells, runs its drawers and seats walk-ins on that
// edge, so the cloud answers 409 POS_WRITE_ON_EDGE. An outlet without one, or
// whose node is revoked, is unchanged (the request reaches its handler), and
// the edge process itself is never refused. The gate runs after the
// permission guard: a caller without the permission still gets 403.
import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const roleId = randomUUID();
const viewerRoleId = randomUUID();
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: ReturnType<typeof agent>;
let stranger: ReturnType<typeof agent>;
let viewer: ReturnType<typeof agent>;
// Rows of the outlet the order-, facility- and session-scoped routes resolve.
const orderUlid = createUlid();
const facilityId = randomUUID();
const sessionId = randomUUID();
const stationId = randomUUID();
const tableIds = [randomUUID(), randomUUID()];
const linkGroupId = randomUUID();
const deviceId = randomUUID();

const base = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}`;
const order = () => `/api/pos/orders/${encodeURIComponent(orderUlid)}`;
const session = (action: string) =>
  `/api/table-sessions/${encodeURIComponent(sessionId)}/${action}`;
const key = () => ({ idempotencyKey: randomUUID() });

type Write = [
  name: string,
  path: () => string,
  body: () => object,
  method?: "post" | "put" | "patch",
  /** The signed device token: the credential of the PIN session routes. */
  device?: true,
];

/**
 * Every gated cloud write (R2: a route that loses its gate fails here), with a
 * body the route parses before the gate; its handler would refuse the rest.
 */
const writes: Write[] = [
  ["create order", () => `${base()}/pos/orders`, key],
  ["park order", () => `${base()}/pos/parked-orders`, key],
  ["open shift", () => `${base()}/pos/shifts`, key],
  [
    "cash movement",
    () => `${base()}/pos/shifts/${randomUUID()}/cash-movements`,
    key,
  ],
  [
    "walk-in seating",
    () => `${base()}/tables/${randomUUID()}/staff-session`,
    key,
  ],
  ["points quote", () => `${order()}/points/quote`, () => ({ points: 10 })],
  ["points redeem", () => `${order()}/points/redeem`, key],
  [
    "ticket sale",
    () => "/api/facility/tickets/pos",
    () => ({
      facilityId,
      areaId: randomUUID(),
      productId: randomUUID(),
      customerProfileId: randomUUID(),
      timing: { kind: "now" },
      ...key(),
    }),
  ],
  [
    "ticket credential",
    () => `${order()}/tickets/${randomUUID()}/credential`,
    key,
  ],
  ["session confirm", () => session("confirm"), () => ({})],
  ["session close", () => session("close"), key],
  ["session move", () => session("move"), key],
  ["session merge", () => session("merge"), key],
  ["session move items", () => session("move-items"), key],
  // E3b: the rest of the POS, KDS, floor and delivery writes.
  ["void order", () => `${base()}/pos/orders/${orderUlid}/void`, () => ({})],
  ["qris cancel", () => `${base()}/pos/orders/${orderUlid}/qris/cancel`, key],
  ["qris release", () => `${base()}/pos/orders/${orderUlid}/qris/release`, key],
  [
    "payment intent resolve",
    () => `${base()}/pos/orders/${orderUlid}/payment-intents/resolve`,
    key,
  ],
  ["va release", () => `${base()}/pos/orders/${orderUlid}/va/release`, key],
  [
    "correction void",
    () => `${base()}/pos/orders/${orderUlid}/corrections/void`,
    key,
  ],
  [
    "correction refund",
    () => `${base()}/pos/orders/${orderUlid}/corrections/refund`,
    key,
  ],
  ["shift count", () => `${base()}/pos/shifts/${randomUUID()}/counts`, key],
  ["shift close", () => `${base()}/pos/shifts/${randomUUID()}/close`, key],
  [
    "shift force close",
    () => `${base()}/pos/shifts/${randomUUID()}/force-close`,
    key,
  ],
  [
    "held cash decision",
    () =>
      `${base()}/pos/shifts/${randomUUID()}/cash-movements/${randomUUID()}/decision`,
    key,
  ],
  ["order customer", () => `${order()}/customer`, () => ({}), "put"],
  ["issue receipt", () => `${base()}/pos/orders/${orderUlid}/receipts`, key],
  ["receipt link", () => `${base()}/pos/receipts/${randomUUID()}/link`, key],
  ["invoice", () => `${base()}/pos/orders/${orderUlid}/invoices`, key],
  [
    "pin session",
    () => "/api/staff-pins/pos-session",
    () => ({}),
    "post",
    true,
  ],
  [
    "pin session end",
    () => "/api/staff-pins/pos-session/end",
    () => ({}),
    "post",
    true,
  ],
  [
    "kds heartbeat",
    () => `${base()}/kitchen/stations/${stationId}/heartbeat`,
    () => ({}),
  ],
  ["kds start", () => kitchenTicket("start"), () => ({})],
  ["kds bump", () => kitchenTicket("bump"), () => ({})],
  ["kds recall", () => kitchenTicket("recall"), () => ({})],
  ["kds void", () => kitchenTicket("void"), () => ({})],
  ["kds priority", () => kitchenTicket("priority"), () => ({}), "patch"],
  [
    "kds item status",
    () => `${base()}/kitchen/ticket-items/${randomUUID()}/status`,
    () => ({}),
  ],
  ["table link", () => "/api/table-links", () => ({ tableIds })],
  ["table unlink", () => `/api/table-links/${linkGroupId}/unlink`, () => ({})],
  ["delivery manual", () => `${base()}/delivery-orders/manual`, () => ({})],
  [
    "delivery status",
    () => `${base()}/delivery-orders/${randomUUID()}/status`,
    () => ({}),
  ],
  [
    "delivery map lines",
    () => `${base()}/delivery-orders/${randomUUID()}/map-lines`,
    () => ({}),
  ],
];

/**
 * E3b: cloud writes that stay open on an outlet its edge serves. Day close has
 * its own DAY_CLOSE_ON_EDGE (Q24 failover); the receipt write-off is the
 * owner's cloud action for that day close (the service refuses on an edge);
 * the delivery platform sync touches only the platform's sync state; an
 * apology voucher is a cloud CRM record (one per issue or idempotency key).
 */
const cloudWrites: Write[] = [
  ["day close", () => `${base()}/pos/day/close`, () => ({})],
  ["receipt write-off", () => `${base()}/pos/receipt-writeoffs`, () => ({})],
  [
    "delivery sync resend",
    () => `${base()}/delivery-orders/${randomUUID()}/platform-sync/resend`,
    () => ({}),
  ],
  [
    "delivery sync resolve",
    () => `${base()}/delivery-orders/${randomUUID()}/platform-sync/resolve`,
    () => ({}),
  ],
  [
    "apology voucher",
    () => "/api/apology-vouchers",
    () => ({ valueIdr: 5000, reason: "Pesanan terlambat lama" }),
  ],
];

function kitchenTicket(action: string) {
  return `${base()}/kitchen/tickets/${randomUUID()}/${action}`;
}

function deviceToken() {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

function post(write: Write, client = cashier) {
  const request = client[write[3] ?? "post"](write[1]())
    .set(headers)
    .set(originHeader);
  // Only the outlet's own device carries its token (R1 callers have none).
  if (write[4] && client === cashier)
    request.set(DEVICE_TOKEN_HEADER, deviceToken());
  return request.send(write[2]());
}

async function seedOutletRows(): Promise<void> {
  const t = tenant.tenantId;
  const o = tenant.outletId;
  const orderId = ulidToUuid(orderUlid);
  await owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at, deposit_applied_idr)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 10000, 0, 0, 0, 0, 10000,
             'draft', '2026-11-20', now(), 0)`,
    [orderId, t, o, `GATE-${orderUlid.slice(-6)}`],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
     VALUES ($1, $2, $3, 'pos', now())`,
    [orderId, t, o],
  );
  await owner.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, 'Shower Gerbang', 'shower', 20, 10, 10, $4, $5, $6)`,
    [
      facilityId,
      t,
      o,
      JSON.stringify([
        {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "00:00",
          closesAt: "23:59",
        },
      ]),
      JSON.stringify({
        graceMinutes: 5,
        blockMinutes: 15,
        feePerBlockIdr: 5000,
      }),
      JSON.stringify({
        freeCancelMinutesBefore: 30,
        lateCancelResolution: "no_refund",
        lateCancelFeeIdr: 0,
        noShowResolution: "no_refund",
      }),
    ],
  );
  const zoneId = randomUUID();
  const tableId = randomUUID();
  await owner.query(
    `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
     VALUES ($1, $2, $3, 'Zona Gerbang', 'pay_first', '[]')`,
    [zoneId, t, o],
  );
  for (const [index, id] of [tableId, ...tableIds].entries())
    await owner.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', '{}')`,
      [id, t, o, zoneId, `G${index + 1}`],
    );
  await owner.query(
    `INSERT INTO table_link_groups (id, tenant_id, outlet_id) VALUES ($1, $2, $3)`,
    [linkGroupId, t, o],
  );
  await owner.query(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
     VALUES ($1, $2, $3, 'Dapur Gerbang', 'hot_kitchen')`,
    [stationId, t, o],
  );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', 'Kasir Gerbang', now() - interval '1 minute', false)`,
    [deviceId, t, o],
  );
  await owner.query(
    `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
       session_token_hash, session_token_sealed)
     VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed')`,
    [sessionId, t, o, tableId, randomBytes(32).toString("hex")],
  );
}

async function addEdge(role: "primary" | "standby") {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, 'active', 'Server lokal', $5, now())`,
    [id, tenant.tenantId, tenant.outletId, role, "c".repeat(64)],
  );
  return id;
}

async function revoke(id: string) {
  await owner.query(
    "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
    [id],
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`gate-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Gerbang', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify([
        "pos.sale.create",
        "shift.cash.operate",
        "floor.table.operate",
        "pos.payment.accept",
        "pos.void.request",
        "pos.refund.request",
        "payment.reconcile",
        "shift.cash.approve_close",
        "pos.day.close",
        "pos.receipt.writeoff",
        "kds.ticket.process",
        "delivery.order.handle",
        "order.apology_voucher.issue",
      ]),
    ],
  );
  cashier = agent(app);
  await signUp(cashier, "Kasir Gerbang");
  const session = await cashier.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  stranger = agent(app);
  await signUp(stranger, "Tanpa Izin");
  // R1: a member of the tenant without the POS or floor permission.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Lihat Saja', false, NULL, '["order.view"]', false, '["tenant"]')`,
    [viewerRoleId, tenant.tenantId],
  );
  viewer = agent(app);
  await signUp(viewer, "Lihat Saja");
  const viewerSession = await viewer.get("/api/auth/get-session");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, viewerSession.body.user.id as string, viewerRoleId],
  );
  await seedOutletRows();
  setDeviceOutletResolver(async (input) =>
    input.tenantId === tenant.tenantId && input.deviceId === deviceId
      ? tenant.outletId
      : null,
  );
}, 120_000);

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("1269 E3 POS_WRITE_ON_EDGE over HTTP", () => {
  it("an outlet without an edge node: every write reaches its handler", async () => {
    for (const write of writes) {
      const name = write[0];
      const response = await post(write);
      expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
    }
  });

  it("an active primary edge: every write is 409 POS_WRITE_ON_EDGE", async () => {
    const id = await addEdge("primary");
    try {
      for (const write of writes) {
        const name = write[0];
        const response = await post(write);
        expect(response.status, name).toBe(409);
        expect(response.body.error.code, name).toBe("POS_WRITE_ON_EDGE");
        expect(response.body.error.message, name).toMatch(/server lokal/i);
      }
    } finally {
      await revoke(id);
    }
  });

  it("a standby-only edge (no primary) is refused too: in doubt the cloud does not sell", async () => {
    const id = await addEdge("standby");
    try {
      for (const write of writes) {
        const name = write[0];
        const response = await post(write);
        expect(response.status, name).toBe(409);
        expect(response.body.error.code, name).toBe("POS_WRITE_ON_EDGE");
      }
    } finally {
      await revoke(id);
    }
  });

  it("a revoked edge node leaves the outlet to the cloud again", async () => {
    for (const write of writes) {
      const name = write[0];
      const response = await post(write);
      expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
    }
  });

  it("R1 a caller without the permission (stranger or tenant member) never learns of the edge: no 409", async () => {
    const id = await addEdge("primary");
    try {
      for (const write of writes) {
        for (const client of [stranger, viewer]) {
          const response = await post(write, client);
          expect([401, 403, 404], write[0]).toContain(response.status);
          expect(response.body.error?.code, write[0]).not.toBe(
            "POS_WRITE_ON_EDGE",
          );
        }
      }
    } finally {
      await revoke(id);
    }
  });

  it("E3b cloud-owned writes stay open on an outlet its edge serves", async () => {
    const id = await addEdge("primary");
    try {
      for (const write of cloudWrites) {
        const response = await post(write);
        expect(response.body.error?.code, write[0]).not.toBe(
          "POS_WRITE_ON_EDGE",
        );
      }
    } finally {
      await revoke(id);
    }
  });

  it("the edge process itself is never refused", async () => {
    const id = await addEdge("primary");
    const before = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({ ...before, edgeMode: true });
    try {
      for (const write of writes) {
        const name = write[0];
        const response = await post(write);
        expect(response.body.error?.code, name).not.toBe("POS_WRITE_ON_EDGE");
      }
    } finally {
      setEdgeRuntimeStateForTests(before);
      await revoke(id);
    }
  });
});

// 1269 E6 (docs/briefs/1269-e6-keputusan.md): back office refunds an edge
// sale the cloud ingested on an outlet its edge serves; nothing else opens.
describe("1269 E6 refund of an ingested edge sale on an edge outlet", () => {
  const ingestedUlid = createUlid();
  const failoverUlid = createUlid();
  const corrections = (ulid: string, action: string) =>
    `${base()}/pos/orders/${encodeURIComponent(ulid)}/corrections/${action}`;

  async function seed(): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const t = tenant.tenantId;
      const o = tenant.outletId;
      const windowId = randomUUID();
      await client.query(
        `INSERT INTO outlet_failover_windows (id, tenant_id, outlet_id, edge_node_id, status,
           reason, idempotency_key, activated_by, business_date_from, business_date_to,
           return_started_at, return_started_by, closed_at)
         VALUES ($1, $2, $3, $4, 'closed', 'Server lokal mati', $5, 'owner', '2026-11-20',
           '2026-11-20', now(), 'owner', now())`,
        [windowId, t, o, randomUUID(), randomUUID()],
      );
      for (const [ulid, window] of [
        [ingestedUlid, null],
        [failoverUlid, windowId],
      ] as const) {
        const id = ulidToUuid(ulid);
        await client.query(
          `INSERT INTO orders
             (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
              subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
              status, business_date, placed_at, deposit_applied_idr)
           VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 10000, 0, 0, 0, 0, 10000,
                   'completed', '2026-11-20', now(), 0)`,
          [id, t, o, `E6-${ulid.slice(-6)}`],
        );
        await client.query(
          `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at,
             completed_at, failover_window_id)
           VALUES ($1, $2, $3, 'pos', now(), now(), $4)`,
          [id, t, o, window],
        );
      }
      await client.query(
        `INSERT INTO edge_order_ingests (tenant_id, order_id, outlet_id, paid_event_id, state)
         VALUES ($1, $2, $3, $4, 'ingested')`,
        [t, ulidToUuid(ingestedUlid), o, ulidToUuid(createUlid())],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("the refund of an ingested edge sale reaches its handler; its void and every other order stay refused", async () => {
    await seed();
    const id = await addEdge("primary");
    try {
      const refund = await post([
        "refund",
        () => corrections(ingestedUlid, "refund"),
        key,
      ]);
      expect(refund.body.error?.code).not.toBe("POS_WRITE_ON_EDGE");
      const payout = await post([
        "payout",
        () => `${corrections(ingestedUlid, "refunds")}/${randomUUID()}/payout`,
        key,
      ]);
      expect(payout.body.error?.code).not.toBe("POS_WRITE_ON_EDGE");
      // D3: no void after payment from back office.
      const voided = await post([
        "void",
        () => corrections(ingestedUlid, "void"),
        key,
      ]);
      expect(voided.status).toBe(409);
      expect(voided.body.error.code).toBe("POS_WRITE_ON_EDGE");
      // A failover order (F series) after the return stays refused (F3 v1).
      const failover = await post([
        "failover refund",
        () => corrections(failoverUlid, "refund"),
        key,
      ]);
      expect(failover.status).toBe(409);
      expect(failover.body.error.code).toBe("POS_WRITE_ON_EDGE");
    } finally {
      await revoke(id);
    }
  });
});

