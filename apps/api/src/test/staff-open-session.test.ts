// Walk-in seating (POS B1, brief 1268):
// POST /api/outlets/:outletId/tables/:tableId/staff-session.
//
// Contract (HTTP + DB rows only):
//  - floor.table.operate seats a party at an empty table; the session is a
//    normal table session (pay-first opens at once), the table turns occupied.
//  - The same key answers the same session and writes nothing twice.
//  - Two devices racing for one table give one session; the loser gets 409.
//  - A dirty or inactive table, a table of another outlet or tenant, and a
//    caller without the permission are refused and write no session.
//  - A shared device must carry a cashier token (ACTING_STAFF_REQUIRED).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
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
  owner,
  seedTenantOutlets,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const [device, sharedDevice] = [randomUUID(), randomUUID()];
const roles = { till: randomUUID(), limited: randomUUID() };
const HOURS = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
];

type Member = { client: ReturnType<typeof agent>; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let till: Member;
let cashierB: Member;
let limited: Member;
let payFirstZone: string;
let otherOutletId: string;

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

const deviceToken = (deviceId = device) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function tokenFor(
  who: Member,
  client: Member = till,
  deviceId = device,
): Promise<string> {
  const response = await client.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

const newKey = () => `walkin-${randomUUID()}`;

/** POST as `who` on the registered till device; `token` adds X-Acting-Staff. */
function seat(
  tableId: string,
  body: Record<string, unknown>,
  options: {
    client?: Member;
    token?: string;
    outletId?: string;
    deviceId?: typeof device;
  } = {},
) {
  // A cashier token is bound to the login session of the till it was issued on.
  const request = (options.client ?? till).client
    .post(
      `/api/outlets/${options.outletId ?? tenant.outletId}/tables/${tableId}/staff-session`,
    )
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(options.deviceId));
  return (
    options.token ? request.set(ACTING_HEADER, options.token) : request
  ).send(body);
}

async function emptyTable(): Promise<string> {
  const table = await createTable(
    till.client,
    { zoneId: payFirstZone },
    headers,
  );
  return table.id as string;
}

async function sessionsOf(tableId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id, status FROM table_sessions WHERE tenant_id = $1 AND table_id = $2`,
    [tenant.tenantId, tableId],
  );
  return rows;
}

async function tableStatus(tableId: string) {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM tables WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, tableId],
  );
  return rows[0]?.status;
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

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`soss-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId &&
    (deviceId === device || deviceId === sharedDevice)
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      roles.till,
      "Meja Walk-in",
      [
        "order.view",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
      ],
    ],
    [roles.limited, "Meja Walk-in Terbatas", ["order.view"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  till = await member("Walkin Till", roles.till);
  cashierB = await member("Walkin Kasir B", roles.till);
  limited = await member("Walkin Terbatas", roles.limited);
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
     VALUES ($1, $2, $3, 'pos', 'Kasir Walkin 1', now() - interval '1 minute')`,
    [device, tenant.tenantId, tenant.outletId],
  );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', 'Kasir Bersama 1', now() - interval '1 minute', true)`,
    [sharedDevice, tenant.tenantId, tenant.outletId],
  );
  payFirstZone = (await createZone(till.client, { hours: HOURS }, headers)).id;
  // A second outlet in the same tenant (the till's token is bound to the first).
  otherOutletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua Walkin', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE id = $3`,
    [
      otherOutletId,
      `W2${randomUUID().slice(0, 6)}`.toUpperCase(),
      tenant.outletId,
    ],
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("POST /api/outlets/:outletId/tables/:tableId/staff-session", () => {
  it("seats a walk-in party and marks the table occupied", async () => {
    const tableId = await emptyTable();

    const response = await seat(tableId, { pax: 3, idempotencyKey: newKey() });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      tableId,
      pax: 3,
      status: "open",
      reservationId: null,
    });
    expect(await sessionsOf(tableId)).toHaveLength(1);
    expect(await tableStatus(tableId)).toBe("occupied");
  });

  it("answers a repeated key with the same session and writes nothing twice", async () => {
    const tableId = await emptyTable();
    const body = { pax: 2, idempotencyKey: newKey() };

    const first = await seat(tableId, body);
    const again = await seat(tableId, body);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await sessionsOf(tableId)).toHaveLength(1);
    const { rows } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'table_session.opened'`,
      [tenant.tenantId, first.body.data.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses the same key with another pax or table", async () => {
    const tableId = await emptyTable();
    const key = newKey();
    expect((await seat(tableId, { pax: 2, idempotencyKey: key })).status).toBe(
      200,
    );

    expectError(
      await seat(tableId, { pax: 4, idempotencyKey: key }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    const other = await emptyTable();
    expectError(
      await seat(other, { pax: 2, idempotencyKey: key }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(await sessionsOf(other)).toHaveLength(0);
  });

  it("gives one session when two devices race for the same table", async () => {
    const tableId = await emptyTable();
    const tokenB = await tokenFor(cashierB);

    const [a, b] = await Promise.all([
      seat(tableId, { pax: 2, idempotencyKey: newKey() }),
      seat(tableId, { pax: 4, idempotencyKey: newKey() }, { token: tokenB }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it("answers a second party at a seated table with 409 CONFLICT", async () => {
    const tableId = await emptyTable();
    expect(
      (await seat(tableId, { pax: 2, idempotencyKey: newKey() })).status,
    ).toBe(200);

    expectError(
      await seat(tableId, { pax: 2, idempotencyKey: newKey() }),
      409,
      "CONFLICT",
    );
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it.each(["dirty", "inactive"])("refuses a %s table", async (status) => {
    const tableId = await emptyTable();
    await owner.query(
      `UPDATE tables SET status = $1 WHERE tenant_id = $2 AND id = $3`,
      [status, tenant.tenantId, tableId],
    );

    expectError(
      await seat(tableId, { pax: 2, idempotencyKey: newKey() }),
      409,
      "CONFLICT",
    );
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("does not find a table through another outlet's path", async () => {
    const tableId = await emptyTable();

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { outletId: otherOutletId },
    );

    // The till's token reaches only its own outlet: no session either way.
    expect([403, 404]).toContain(response.status);
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("does not find a table of another tenant", async () => {
    const [foreignOutlet] = await seedTenantOutlets(randomUUID(), 1);
    const foreignTable = randomUUID();

    const response = await seat(
      foreignTable,
      { pax: 2, idempotencyKey: newKey() },
      { outletId: foreignOutlet },
    );

    expect([403, 404]).toContain(response.status);
    expect(await sessionsOf(foreignTable)).toHaveLength(0);
  });

  it("refuses a cashier without floor.table.operate", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(limited);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { token },
    );

    expectError(response, 403, "PERMISSION_DENIED");
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });

  it("records the acting cashier as the one who seated the party", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(cashierB);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { token },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { rows } = await owner.query<{ actor: string }>(
      `SELECT event->'actor'->>'id' AS actor FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'table_session.opened'`,
      [tenant.tenantId, response.body.data.id],
    );
    expect(JSON.stringify(rows)).toContain(cashierB.userId);
  });

  it("on a shared device needs a cashier token, and a token seats the party", async () => {
    const tableId = await emptyTable();
    // A fresh login on a device flagged shared: marks stick to that session.
    const sharedTill = await member("Walkin Bersama", roles.till);

    const response = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { client: sharedTill, deviceId: sharedDevice },
    );

    expectError(response, 401, "ACTING_STAFF_REQUIRED");
    expect(await sessionsOf(tableId)).toHaveLength(0);

    const token = await tokenFor(cashierB, sharedTill, sharedDevice);
    const seated = await seat(
      tableId,
      { pax: 2, idempotencyKey: newKey() },
      { client: sharedTill, deviceId: sharedDevice, token },
    );
    expect(seated.status, JSON.stringify(seated.body)).toBe(200);
    expect(await sessionsOf(tableId)).toHaveLength(1);
  });

  it("rejects a body that carries unknown fields or a bad pax", async () => {
    const tableId = await emptyTable();
    const token = await tokenFor(cashierB);

    for (const body of [
      { pax: 0, idempotencyKey: newKey() },
      { pax: 31, idempotencyKey: newKey() },
      { pax: 2 },
      { pax: 2, idempotencyKey: newKey(), tenantId: tenant.tenantId },
    ])
      expect(
        (await seat(tableId, body, { token })).status,
        JSON.stringify(body),
      ).toBe(422);
    expect(await sessionsOf(tableId)).toHaveLength(0);
  });
});
