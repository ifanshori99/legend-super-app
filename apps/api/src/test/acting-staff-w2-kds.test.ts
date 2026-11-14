// Acting staff on the KDS router (wave 2, legend-ptn11). Spec = DECISIONS.md
// "Kasir aktif per perangkat lewat token server": a call that carries
// X-Acting-Staff runs as that staff member (actor + permissions), a bad token is
// 401 and never falls back to the session owner, no header keeps the owner.
//
// Per mutation route (start, bump, recall, void, priority, ticket-items status,
// capacity-rules, menu-loads set/delete, channel-pauses set/release):
//  (a) valid token of cashierB => 2xx, recorded actor = cashierB (not the owner);
//  (b) token of a staff member with order.view only => 403 PERMISSION_DENIED;
//  (c) garbage token => 401 ACTING_STAFF_INVALID.
//
// Assumptions (spec silent):
//  - Ticket routes: actor = kitchen_ticket_status_changes.actor_id of the rows the
//    call wrote. Ticket rows are inserted directly (the API ids are the ULID
//    form of the row uuid).
//  - Menu-load / channel-pause routes: actor = audit_logs.event.actorId of the
//    event for the row id (same shape as kds-pacing-admin.test.ts).
//  - Priority and capacity-rules (no status change, no actor column) must write
//    one audit_logs event each whose actorId is the actor. The action names are
//    not fixed by the spec, so the event is found by the ids it names (ticket
//    uuid or ULID, station id) and the audit objectId/ids may be either form.
//  - Routes need kds.ticket.process (tickets) or kds.station.manage (admin).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, uuidToUlid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const device = randomUUID();
const till = randomUUID();
const limitedRole = randomUUID();
const HOUR = 3_600_000;

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
type Req = ReturnType<Client["get"]>;
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let cashierB: Member;
let limited: Member;

async function asTenant<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function member(label: string, roleId: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
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

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: device,
  });

function withIdentity(request: Req, token: string | null): Req {
  const base = request
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken());
  return token ? base.set("X-Acting-Staff", token) : base;
}

async function issueToken(who: Member): Promise<string> {
  const response = await sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

const base = () =>
  `/api/outlets/${encodeURIComponent(tenant.outletId)}/kitchen`;
const send = (
  method: "post" | "put" | "patch" | "delete",
  path: string,
  token: string | null,
  body?: object,
  who: Member = sessionOwner,
) => {
  const request = withIdentity(who.client[method](`${base()}${path}`), token);
  return body ? request.send(body) : request.send({});
};

// ---- fixtures -----------------------------------------------------------------

async function station(): Promise<string> {
  const id = randomUUID();
  await asTenant((c) =>
    c.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'hot_kitchen')`,
      [id, tenant.tenantId, tenant.outletId, `Dapur ${id.slice(0, 6)}`],
    ),
  );
  return id;
}

async function menuItem(): Promise<string> {
  const id = randomUUID();
  const category = randomUUID();
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Uji', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
       VALUES ($1, $2, $3, $4, $5, true, $6, NULL, NULL)`,
      [
        id,
        tenant.tenantId,
        tenant.brandId,
        category,
        `Menu ${id.slice(0, 6)}`,
        randomUUID(),
      ],
    );
  });
  return id;
}

type TicketStatus = "new" | "in_progress" | "done";

/** One ticket with one line; the ids come back in API (ULID) form. */
async function ticket(status: TicketStatus) {
  const stationId = await station();
  const itemId = await menuItem();
  const [ticketId, orderId, orderItemId, lineId] = [1, 2, 3, 4].map(() =>
    randomUUID(),
  );
  const firedAt = new Date(Date.now() - 60_000);
  const lineStatus =
    status === "new" ? "queued" : status === "done" ? "ready" : "in_progress";
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 10000, 0, 0, 0, 0, 10000,
               'sent', '2026-11-10', $5)`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `AS-${orderId.slice(0, 8)}`,
        firedAt,
      ],
    );
    await c.query(
      `INSERT INTO kitchen_tickets
         (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no,
          status, priority, fired_at, started_at, done_at, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'),
               $7, 0, $8, $9, $10, NULL)`,
      [
        ticketId,
        tenant.tenantId,
        tenant.outletId,
        orderId,
        stationId,
        randomUUID(),
        status,
        firedAt,
        status === "new" ? null : firedAt,
        status === "done" ? firedAt : null,
      ],
    );
    await c.query(
      `INSERT INTO order_items
         (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name, quantity,
          unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Baris Uji', 1, 10000, 0, 10000, '[]'::jsonb,
               'fired', 'queued', '2026-11-10')`,
      [orderItemId, tenant.tenantId, tenant.outletId, orderId, itemId],
    );
    await c.query(
      `INSERT INTO kitchen_ticket_items
         (id, tenant_id, outlet_id, ticket_id, order_id, order_item_id, menu_item_id,
          variant_id, name, quantity, status, fired_at, started_at, ready_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'Baris Uji', 1, $8, $9, $10, $11)`,
      [
        lineId,
        tenant.tenantId,
        tenant.outletId,
        ticketId,
        orderId,
        orderItemId,
        itemId,
        lineStatus,
        firedAt,
        status === "new" ? null : firedAt,
        status === "done" ? firedAt : null,
      ],
    );
  });
  return {
    id: uuidToUlid(ticketId),
    uuid: ticketId,
    lineId: uuidToUlid(lineId),
  };
}

async function ticketActors(ticketUuid: string): Promise<string[]> {
  const { rows } = await asTenant((c) =>
    c.query<{ actor_id: string | null }>(
      `SELECT actor_id::text AS actor_id FROM kitchen_ticket_status_changes WHERE ticket_id = $1::uuid`,
      [ticketUuid],
    ),
  );
  return rows.map((r) => r.actor_id).filter((a): a is string => a !== null);
}

async function auditActors(action: string, objectId: string) {
  const { rows } = await owner.query<{ actor: string | null }>(
    `SELECT event->>'actorId' AS actor FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenant.tenantId, action, objectId],
  );
  return rows.map((r) => r.actor).filter((a): a is string => a !== null);
}

/** Actor ids of audit events that name any of `refs` (row ids in uuid/ULID form). */
async function auditActorsNaming(...refs: string[]): Promise<string[]> {
  const { rows } = await owner.query<{ actor: string | null }>(
    `SELECT event->>'actorId' AS actor FROM audit_logs
      WHERE tenant_id = $1 AND event->>'actorType' = 'user'
        AND event->>'action' NOT LIKE 'pos_acting_staff.%'
        AND event::text ILIKE ANY (SELECT '%' || r || '%' FROM unnest($2::text[]) AS r)`,
    [tenant.tenantId, refs],
  );
  return rows.map((r) => r.actor).filter((a): a is string => a !== null);
}

// ---- cases --------------------------------------------------------------------

type Prepared = {
  call: (token: string) => Req;
  actors: (response: { body: { data?: unknown } }) => Promise<string[]>;
};
type Case = { name: string; prepare: () => Promise<Prepared> };

const rule = {
  windowMinutes: 15,
  capacityPoints: 40,
  nearCapacityBp: 8000,
  schedule: [{ daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "22:00" }],
  channelPriority: ["dine_in", "gofood"],
};
const pauseBody = (menuItemId: string) => ({
  menuItemId,
  variantId: null,
  channels: ["gofood"],
  pausedUntil: new Date(Date.now() + HOUR).toISOString(),
});
const idsOf = (body: { data?: unknown }) =>
  (Array.isArray(body.data) ? body.data : [body.data]).map(
    (row) => (row as { id: string }).id,
  );

function ticketCase(
  name: string,
  status: TicketStatus,
  route: (id: string) => {
    method: "post" | "patch";
    path: string;
    body?: object;
  },
  noActorColumn = false,
): Case {
  return {
    name,
    prepare: async () => {
      const t = await ticket(status);
      const r = route(t.id);
      return {
        call: (token) => send(r.method, r.path, token, r.body),
        actors: noActorColumn
          ? () => auditActorsNaming(t.id, t.uuid)
          : () => ticketActors(t.uuid),
      };
    },
  };
}

const cases: Case[] = [
  ticketCase("POST tickets/:id/start", "new", (id) => ({
    method: "post",
    path: `/tickets/${id}/start`,
  })),
  ticketCase("POST tickets/:id/bump", "in_progress", (id) => ({
    method: "post",
    path: `/tickets/${id}/bump`,
  })),
  ticketCase("POST tickets/:id/recall", "done", (id) => ({
    method: "post",
    path: `/tickets/${id}/recall`,
    body: { reason: "Salah meja" },
  })),
  ticketCase("POST tickets/:id/void", "new", (id) => ({
    method: "post",
    path: `/tickets/${id}/void`,
    body: { reason: "Bahan habis" },
  })),
  ticketCase(
    "PATCH tickets/:id/priority",
    "new",
    (id) => ({
      method: "patch",
      path: `/tickets/${id}/priority`,
      body: { priority: 3 },
    }),
    true,
  ),
  {
    name: "POST ticket-items/:id/status",
    prepare: async () => {
      const t = await ticket("new");
      return {
        call: (token) =>
          send("post", `/ticket-items/${t.lineId}/status`, token, {
            action: "start",
          }),
        actors: () => ticketActors(t.uuid),
      };
    },
  },
  {
    name: "PUT stations/:id/capacity-rules",
    prepare: async () => {
      const stationId = await station();
      return {
        call: (token) =>
          send("put", `/stations/${stationId}/capacity-rules`, token, {
            rules: [rule],
          }),
        actors: () => auditActorsNaming(stationId),
      };
    },
  },
  {
    name: "PUT menu-loads",
    prepare: async () => {
      const menuItemId = await menuItem();
      return {
        call: (token) =>
          send("put", "/menu-loads", token, {
            loads: [
              { menuItemId, variantId: null, loadPoints: 3, prepSeconds: 900 },
            ],
          }),
        actors: async ({ body }) =>
          (
            await Promise.all(
              idsOf(body).map((id) => auditActors("kitchen_menu_load.set", id)),
            )
          ).flat(),
      };
    },
  },
  {
    name: "DELETE menu-loads/:id",
    prepare: async () => {
      const menuItemId = await menuItem();
      const created = await send("put", "/menu-loads", null, {
        loads: [
          { menuItemId, variantId: null, loadPoints: 3, prepSeconds: 900 },
        ],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const [loadId] = idsOf(created.body);
      return {
        call: (token) => send("delete", `/menu-loads/${loadId}`, token),
        actors: () => auditActors("kitchen_menu_load.deleted", loadId!),
      };
    },
  },
  {
    name: "PUT channel-pauses",
    prepare: async () => {
      const menuItemId = await menuItem();
      return {
        call: (token) =>
          send("put", "/channel-pauses", token, pauseBody(menuItemId)),
        actors: async ({ body }) =>
          (
            await Promise.all(
              idsOf(body).map((id) =>
                auditActors("kitchen_channel_pause.paused", id),
              ),
            )
          ).flat(),
      };
    },
  },
  {
    name: "DELETE channel-pauses/:id",
    prepare: async () => {
      const menuItemId = await menuItem();
      const created = await send(
        "put",
        "/channel-pauses",
        null,
        pauseBody(menuItemId),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const [pauseId] = idsOf(created.body);
      return {
        call: (token) => send("delete", `/channel-pauses/${pauseId}`, token),
        actors: () => auditActors("kitchen_channel_pause.released", pauseId!),
      };
    },
  },
];

function expectError(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`akds-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === device
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      till,
      "KDS Kasir Aktif",
      ["order.view", "kds.ticket.process", "kds.station.manage"],
    ],
    [limitedRole, "KDS Terbatas", ["order.view"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("KDS Sesi Login", till);
  cashierB = await member("KDS Kasir B", till);
  limited = await member("KDS Terbatas", limitedRole);
  const ctx = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  for (const who of [cashierB, limited])
    await setStaffPin(
      ctx,
      who.userId,
      { outletId: tenant.outletId, userId: who.userId },
      { pin: PIN },
    );
  await asTenant((c) =>
    c.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'KDS Kasir Aktif', now() - interval '1 minute')`,
      [device, tenant.tenantId, tenant.outletId],
    ),
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("KDS honors X-Acting-Staff", () => {
  for (const { name, prepare } of cases) {
    describe(name, () => {
      it("valid token: runs as cashierB, recorded actor is cashierB and never the session owner", async () => {
        const { call, actors } = await prepare();
        const response = await call(await issueToken(cashierB));
        expect(response.status, JSON.stringify(response.body)).toBeLessThan(
          300,
        );
        const recorded = await actors(response);
        expect(recorded.length).toBeGreaterThan(0);
        expect(recorded.every((id) => id === cashierB.userId)).toBe(true);
        expect(recorded).not.toContain(sessionOwner.userId);
      });

      it("token of a staff member without the permission: 403 PERMISSION_DENIED although the session owner holds it", async () => {
        const { call } = await prepare();
        expectError(
          await call(await issueToken(limited)),
          403,
          "PERMISSION_DENIED",
        );
      });

      it("garbage token: 401 ACTING_STAFF_INVALID, no fallback to the session owner", async () => {
        const { call } = await prepare();
        expectError(
          await call(`pas_garbage-${randomUUID()}`),
          401,
          "ACTING_STAFF_INVALID",
        );
      });
    });
  }

  it("no header: the session owner stays the actor", async () => {
    const t = await ticket("new");
    const response = await send("post", `/tickets/${t.id}/start`, null);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const recorded = await ticketActors(t.uuid);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((id) => id === sessionOwner.userId)).toBe(true);
  });

  it("no header on priority and capacity-rules: an audit event names the session owner", async () => {
    const t = await ticket("new");
    const priority = await send("patch", `/tickets/${t.id}/priority`, null, {
      priority: 2,
    });
    expect(priority.status, JSON.stringify(priority.body)).toBe(200);
    expect(await auditActorsNaming(t.id, t.uuid)).toEqual([
      sessionOwner.userId,
    ]);
    const stationId = await station();
    const rules = await send(
      "put",
      `/stations/${stationId}/capacity-rules`,
      null,
      { rules: [rule] },
    );
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect(await auditActorsNaming(stationId)).toEqual([sessionOwner.userId]);
  });
});
