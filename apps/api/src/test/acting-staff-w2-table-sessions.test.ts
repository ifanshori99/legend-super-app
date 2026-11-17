// Acting cashier token on table-session routes (bead legend-ptn11, wave 2;
// spec = docs/DECISIONS.md "Kasir aktif per perangkat lewat token server").
//
// Routes under test: POST /api/table-sessions/:id/{confirm,close,move,merge,move-items}.
//
// Contract (HTTP + audit rows only):
//  - X-Acting-Staff with a valid token: the staff member is the actor (audit
//    actorId) and the permission subject; session owner holds the permission
//    but the staff without it is refused 403 PERMISSION_DENIED.
//  - Garbage token: 401 ACTING_STAFF_INVALID, never a fallback to the owner.
//  - No header: the session owner stays the actor.
//
// Assumptions (the spec leaves these open):
//  - The audit actor is read from audit_logs.event->>'actorId' of the row whose
//    action matches the route's table_session.* action and whose JSON mentions
//    the session id (the decision says actorId = acting staff).
//  - The close action is named table_session.closed (matched as 'table_session.clos%').
//  - Every request carries X-Device-Token, as a real POS does.
//  - Sessions are created in a pay_first zone (open at once) or an open_bill
//    zone (pending_confirmation, for the confirm route).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, tenantIdSchema, ulidToUuid } from "@starter/shared/core";
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
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const [device, category, menuItem] = [1, 2, 3].map(() => randomUUID()) as [
  string,
  string,
  string,
];
const roles = { till: randomUUID(), limited: randomUUID() };
const HOURS = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
];

type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
};
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member; // signed in on the till, holds the floor permissions
let cashierB: Member; // same role as the owner
let limited: Member; // order.view only
let payFirstZone: string;
let openBillZone: string;

async function member(label: string, roleId: string): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  void email;
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

async function tokenFor(who: Member): Promise<string> {
  const response = await sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** POST as the signed-in till; `token` adds X-Acting-Staff. */
function post(path: string, body: Record<string, unknown>, token?: string) {
  const request = sessionOwner.client
    .post(`/api/table-sessions/${path}`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken());
  return (token ? request.set(ACTING_HEADER, token) : request).send(body);
}

function expectError(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

/** Actor ids of the audit rows of one action that mention `sessionId`. */
async function actorsOf(sessionId: string, actionLike: string) {
  const { rows } = await owner.query<{ actor: string }>(
    `SELECT event->>'actorId' AS actor FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' LIKE $2
       AND event::text LIKE '%' || $3::text || '%'`,
    [tenant.tenantId, actionLike, sessionId],
  );
  return rows.map((row) => row.actor);
}

async function emptyTable(zoneId = payFirstZone) {
  const table = await createTable(sessionOwner.client, { zoneId }, headers);
  return table.id as string;
}

/** A fresh session. Pay-first sessions are open; open-bill ones stay pending. */
async function newSession(zoneId = payFirstZone) {
  const tableId = await emptyTable(zoneId);
  const qr = await issueQr(sessionOwner.client, tableId, headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  return { sessionId: scanned.body.data.session.id as string, tableId };
}

/** One sent order with two lines in the session; returns the line ids. */
async function seedOrder(sessionId: string): Promise<string[]> {
  const orderUuid = ulidToUuid(createUlid());
  const today = new Date().toISOString().slice(0, 10);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id,
        payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, prices_include_tax, status, business_date, placed_at, fired_at)
     SELECT $1, tenant_id, outlet_id, $2, 'qr', 'dine_in', id, payment_mode, 30000, 0, 0, 0, 0,
        30000, false, 'sent', $3, now(), now()
     FROM table_sessions WHERE id = $4`,
    [orderUuid, `W2-${randomUUID().slice(0, 12)}`, today, sessionId],
  );
  const lineIds: string[] = [];
  for (const [index, price] of [10000, 20000].entries()) {
    const id = createUlid();
    lineIds.push(id);
    await owner.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       SELECT $1, tenant_id, outlet_id, id, $2, NULL, $3, 1, $4, 0, $4, '[]'::jsonb,
          'fired', 'queued', $5
       FROM orders WHERE id = $6`,
      [ulidToUuid(id), menuItem, `Item ${index + 1}`, price, today, orderUuid],
    );
  }
  return lineIds;
}

// One entry per route: how to build a fixture, call it, and which audit row
// records the actor.
type Fixture = {
  id: string;
  call: (token?: string) => ReturnType<typeof post>;
};
const routes: {
  name: string;
  action: string;
  prepare: () => Promise<Fixture>;
}[] = [
  {
    name: "confirm",
    action: "table_session.confirmed",
    prepare: async () => {
      const { sessionId } = await newSession(openBillZone);
      return {
        id: sessionId,
        call: (token) => post(`${sessionId}/confirm`, {}, token),
      };
    },
  },
  {
    name: "close",
    action: "table_session.clos%",
    prepare: async () => {
      const { sessionId } = await newSession();
      return {
        id: sessionId,
        call: (token) =>
          post(
            `${sessionId}/close`,
            { tableCleaned: true, waiterConfirmedEmpty: true },
            token,
          ),
      };
    },
  },
  {
    name: "move",
    action: "table_session.moved",
    prepare: async () => {
      const { sessionId } = await newSession();
      const toTableId = await emptyTable();
      return {
        id: sessionId,
        call: (token) => post(`${sessionId}/move`, { toTableId }, token),
      };
    },
  },
  {
    name: "merge",
    action: "table_session.merged",
    prepare: async () => {
      const target = await newSession();
      const source = await newSession();
      return {
        id: target.sessionId,
        call: (token) =>
          post(
            `${target.sessionId}/merge`,
            { sourceSessionId: source.sessionId },
            token,
          ),
      };
    },
  },
  {
    name: "move-items",
    action: "table_session.items_moved",
    prepare: async () => {
      const from = await newSession();
      const to = await newSession();
      const orderItemIds = await seedOrder(from.sessionId);
      return {
        id: from.sessionId,
        call: (token) =>
          post(
            `${from.sessionId}/move-items`,
            { toSessionId: to.sessionId, orderItemIds },
            token,
          ),
      };
    },
  },
];

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`w2ts-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === device
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      roles.till,
      "Meja Kasir Aktif",
      [
        "order.view",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
      ],
    ],
    [roles.limited, "Meja Terbatas", ["order.view"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("Sesi Login Meja", roles.till);
  cashierB = await member("Kasir B Meja", roles.till);
  limited = await member("Staf Terbatas Meja", roles.limited);
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
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Meja 1', now() - interval '1 minute')`,
    [device, tenant.tenantId, tenant.outletId],
  );
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Meja Aktif', 0)`,
    [category, tenant.tenantId, tenant.brandId],
  );
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Meja', true, $5)`,
    [menuItem, tenant.tenantId, tenant.brandId, category, randomUUID()],
  );
  payFirstZone = (
    await createZone(sessionOwner.client, { hours: HOURS }, headers)
  ).id;
  openBillZone = (
    await createZone(
      sessionOwner.client,
      { paymentMode: "open_bill", hours: HOURS },
      headers,
    )
  ).id;
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe.each(routes)("table-session $name with X-Acting-Staff", (route) => {
  it(`records the acting staff, not the session owner (${route.name})`, async () => {
    const fixture = await route.prepare();
    const token = await tokenFor(cashierB);

    const response = await fixture.call(token);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const actors = await actorsOf(fixture.id, route.action);
    expect(actors).toContain(cashierB.userId);
    expect(actors).not.toContain(sessionOwner.userId);
  });

  it(`refuses a staff member without floor.table.operate even though the session owner has it (${route.name})`, async () => {
    const fixture = await route.prepare();
    const token = await tokenFor(limited);

    const response = await fixture.call(token);

    expectError(response, 403, "PERMISSION_DENIED");
    expect(await actorsOf(fixture.id, route.action)).toEqual([]);
  });

  it(`answers 401 ACTING_STAFF_INVALID to a garbage token and does nothing (${route.name})`, async () => {
    const fixture = await route.prepare();

    const response = await fixture.call("pas_not-a-real-token");

    expectError(response, 401, "ACTING_STAFF_INVALID");
    expect(await actorsOf(fixture.id, route.action)).toEqual([]);
  });
});

describe("table-session without X-Acting-Staff", () => {
  it.each(routes)(
    "$name keeps the session owner as the actor",
    async (route) => {
      const fixture = await route.prepare();

      const response = await fixture.call();

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await actorsOf(fixture.id, route.action)).toContain(
        sessionOwner.userId,
      );
    },
  );
});
