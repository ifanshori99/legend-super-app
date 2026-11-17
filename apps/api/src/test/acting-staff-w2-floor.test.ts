// Acting staff wave 2, floor router (bead legend-ptn11). Fail-first tests.
//
// Contract: floor mutations honor `X-Acting-Staff` (token from POST
// /api/staff-pins/pos-session):
//  - valid token: the acting staff member is the actor (audit_logs / actor
//    columns), permissions are the staff's, never the session owner's.
//  - invalid token: 401 ACTING_STAFF_INVALID, never falls back to the owner.
//  - no header: the session owner stays the actor.
//
// Assumptions:
//  - Actor evidence = every audit_logs row appended by the call (whole row as
//    JSON text) plus, for creates, the actor-ish columns (created_by, actor...)
//    of the new zone/table row. The evidence must contain the acting staff id
//    and never the session owner id. The no-header calibration test proves the
//    evidence helper sees the owner when no header is sent.
//  - Zone edit is PATCH /api/floor/zones/:id; table edit PATCH
//    /api/floor/tables/:id; QR issue is POST /api/tables/:id/qr.
//  - `till` holds floor.table.view/operate/manage + order.view; `limited` only
//    order.view, so any floor mutation as `limited` is 403 PERMISSION_DENIED.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  createFloorZone,
  createTable as createTableService,
} from "../services/floor.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  seededOutletA,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const device = randomUUID();
const roles = { till: randomUUID(), limited: randomUUID() };
/** Extra devices of the isolated tenant's outlet A (resolver knows them). */
const extraDevices = new Set<string>();

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let cashierB: Member;
let limited: Member;

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

async function tokenFor(who: Member): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    who.userId,
    { outletId: tenant.outletId, userId: who.userId },
    { pin: PIN },
  );
  const response = await sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

type Method = "post" | "patch" | "put" | "delete";
function call(
  method: Method,
  path: string,
  token: string | null,
  body?: Record<string, unknown>,
) {
  const request = sessionOwner.client[method](path)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken());
  const withToken = token ? request.set(ACTING_HEADER, token) : request;
  return body ? withToken.send(body) : withToken;
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

const zoneBody = () => ({
  name: `Zona ${randomUUID().slice(0, 8)}`,
  paymentMode: "pay_first",
  serviceChargeBp: 500,
  minimumSpendIdr: 0,
  hours: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" }],
});
const layout = (x = 10) => ({
  x,
  y: 10,
  width: 60,
  height: 60,
  rotation: 0,
  shape: "rect",
});
const tableBody = (zoneId: string) => ({
  zoneId,
  code: `T-${randomUUID().slice(0, 6)}`.toUpperCase(),
  capacity: 4,
  type: "regular",
  layout: layout(),
});

/** Setup writes always run as the plain session owner (no acting header). */
async function setupZone(): Promise<string> {
  const r = await call("post", "/api/floor/zones", null, zoneBody());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}
async function setupTable(zoneId = ""): Promise<string> {
  const zone = zoneId || (await setupZone());
  const r = await call("post", "/api/floor/tables", null, tableBody(zone));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

async function auditRows(): Promise<string[]> {
  const { rows } = await owner.query<{ t: string }>(
    // Only the recorded actor: audit rows of an acting request also name the
    // login session owner by design (recordAudit, getRequestActingStaff).
    "SELECT a.id::text || '|' || coalesce(a.event->>'actorId', '') AS t FROM audit_logs a WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return rows.map((row) => row.t);
}

async function entityActors(entity: "floor_zones" | "tables", id: string) {
  const { rows } = await owner.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS row FROM ${entity} t WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, id],
  );
  return Object.entries(rows[0]?.row ?? {})
    .filter(([key]) => /(created_by|actor|updated_by|changed_by)/i.test(key))
    .map(([, value]) => String(value));
}

/** Runs `run` and returns the actor evidence it produced (see Assumptions). */
async function evidenceOf(
  run: () => Promise<{ status: number; body: unknown }>,
  created?: {
    entity: "floor_zones" | "tables";
    idOf: (b: { data: { id: string } }) => string;
  },
) {
  const before = new Set(await auditRows());
  const response = await run();
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const fresh = (await auditRows()).filter((row) => !before.has(row));
  const columns = created
    ? await entityActors(
        created.entity,
        created.idOf(response.body as { data: { id: string } }),
      )
    : [];
  return [...fresh, ...columns].join("\n");
}

function expectActor(evidence: string, actor: Member) {
  expect(evidence).toContain(actor.userId);
  expect(evidence).not.toContain(sessionOwner.userId);
}

type Case = {
  name: string;
  method: Method;
  path: () => Promise<string>;
  body?: () => Promise<Record<string, unknown>>;
  created?: {
    entity: "floor_zones" | "tables";
    idOf: (b: { data: { id: string } }) => string;
  };
};

const cases: Case[] = [
  {
    name: "floor-zone-create",
    method: "post",
    path: async () => "/api/floor/zones",
    body: async () => zoneBody(),
    created: { entity: "floor_zones", idOf: (b) => b.data.id },
  },
  {
    name: "floor-zone-update",
    method: "patch",
    path: async () => `/api/floor/zones/${await setupZone()}`,
    body: async () => ({ name: `Zona Baru ${randomUUID().slice(0, 6)}` }),
  },
  {
    name: "floor-zone-delete",
    method: "delete",
    path: async () => `/api/floor/zones/${await setupZone()}`,
  },
  {
    name: "floor-table-create",
    method: "post",
    path: async () => "/api/floor/tables",
    body: async () => tableBody(await setupZone()),
    created: { entity: "tables", idOf: (b) => b.data.id },
  },
  {
    name: "floor-table-update",
    method: "patch",
    path: async () => `/api/floor/tables/${await setupTable()}`,
    body: async () => ({ capacity: 6 }),
  },
  {
    name: "floor-table-delete",
    method: "delete",
    path: async () => `/api/floor/tables/${await setupTable()}`,
  },
  {
    name: "floor-layout-save",
    method: "put",
    path: async () => "/api/floor/layout",
    body: async () => ({
      placements: [{ tableId: await setupTable(), layout: layout(33) }],
    }),
  },
  {
    name: "table-qr-issue",
    method: "post",
    path: async () => `/api/tables/${await setupTable()}/qr`,
  },
  {
    name: "table-qr-rotate",
    method: "post",
    path: async () => `/api/tables/${await setupTable()}/qr/rotate`,
  },
  {
    name: "table-status",
    method: "post",
    path: async () => `/api/tables/${await setupTable()}/status`,
    body: async () => ({ action: "mark_dirty" }),
  },
];

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`actf-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId &&
    (deviceId === device || extraDevices.has(deviceId))
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      roles.till,
      "Floor Kasir Aktif",
      [
        "order.view",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
      ],
    ],
    [roles.limited, "Floor Terbatas", ["order.view"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("Sesi Floor", roles.till);
  cashierB = await member("Kasir Floor B", roles.till);
  limited = await member("Staf Floor Terbatas", roles.limited);
  // The device row the pos-session endpoint needs. A new token on the same
  // device switches (revokes) the previous one, so every test issues its own.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir Floor', now() - interval '1 minute')`,
      [device, tenant.tenantId, tenant.outletId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("acting staff on floor mutations (wave 2)", () => {
  // Calibration: without the header the session owner is the actor. Proves
  // the evidence helper finds the actor, so the acting tests fail only on
  // the header.
  it("no header: floor-zone-create records the session owner as actor", async () => {
    const evidence = await evidenceOf(
      () => call("post", "/api/floor/zones", null, zoneBody()),
      { entity: "floor_zones", idOf: (b) => b.data.id },
    );
    expect(evidence).toContain(sessionOwner.userId);
    expect(evidence).not.toContain(cashierB.userId);
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("no header: session owner is the actor (calibration, passes today)", async () => {
        const path = await c.path();
        const body = c.body ? await c.body() : undefined;
        const evidence = await evidenceOf(
          () => call(c.method, path, null, body),
          c.created,
        );
        expect(evidence).toContain(sessionOwner.userId);
        expect(evidence).not.toContain(cashierB.userId);
      });

      it("valid acting token: staff B is the actor, not the session owner", async () => {
        const path = await c.path();
        const body = c.body ? await c.body() : undefined;
        const tokenB = await tokenFor(cashierB);
        const evidence = await evidenceOf(
          () => call(c.method, path, tokenB, body),
          c.created,
        );
        expectActor(evidence, cashierB);
      });

      it("acting staff without the permission is 403 PERMISSION_DENIED", async () => {
        const path = await c.path();
        const body = c.body ? await c.body() : undefined;
        const tokenLimited = await tokenFor(limited);
        expectError(
          await call(c.method, path, tokenLimited, body),
          403,
          "PERMISSION_DENIED",
        );
      });

      it("garbage acting token is 401 ACTING_STAFF_INVALID, no owner fallback", async () => {
        const path = await c.path();
        const body = c.body ? await c.body() : undefined;
        expectError(
          await call(c.method, path, "pas_garbage", body),
          401,
          "ACTING_STAFF_INVALID",
        );
      });
    });
  }
});

// Outlet binding. The token is issued for outlet 1 (the device is bound to it)
// while the tenant has a second outlet. Assumptions:
//  - "First outlet" is made deterministic by giving outlet 2 an earlier
//    created_at, a code and a uuid that sort before outlet 1's, so any
//    "first outlet of the tenant" pick lands on outlet 2.
//  - This describe runs after the one above on purpose: adding outlet 2 changes
//    where header-less floor calls land, which the tests above do not expect.
//  - The outlet-2 table is created through the service (explicit outletId); a
//    header-less call by the tenant-wide session owner on it must reach it
//    (200), which proves the route finds it and the refusal below is the
//    outlet check, not a 404.
describe("acting staff stays inside the outlet of its token (wave 2)", () => {
  const outlet2 = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  let outlet2TableId: string;
  let calibrationTableId: string; // own table: mark_dirty is not repeatable

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Dua', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active', now() - interval '30 days')`,
      [
        outlet2,
        tenant.tenantId,
        tenant.brandId,
        tenant.legalEntityId,
        `AAA-${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const zone = await createFloorZone(
      context,
      outlet2,
      {
        name: `Zona Outlet Dua ${randomUUID().slice(0, 6)}`,
        paymentMode: "open_bill",
        serviceChargeBp: 0,
        minimumSpendIdr: idr(0),
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        status: "active",
        sortOrder: 1,
      },
      sessionOwner.userId,
    );
    const makeTable = async () =>
      (
        await createTableService(
          context,
          {
            zoneId: zone.id,
            code: `D-${randomUUID().slice(0, 5)}`.toUpperCase(),
            capacity: 4,
            type: "regular",
            layout: layout(),
            status: "available",
          } as Parameters<typeof createTableService>[1],
          sessionOwner.userId,
        )
      ).id;
    outlet2TableId = await makeTable();
    calibrationTableId = await makeTable();
  });

  it("calibration: the tenant-wide session owner (no header) reaches the outlet-2 table", async () => {
    const response = await call(
      "post",
      `/api/tables/${calibrationTableId}/status`,
      null,
      { action: "mark_dirty" },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("zone created with an outlet-1 token lands in outlet 1 only, never outlet 2", async () => {
    const token = await tokenFor(cashierB);
    const response = await call("post", "/api/floor/zones", token, zoneBody());
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const { rows } = await owner.query<{ outlet_id: string }>(
      "SELECT outlet_id FROM floor_zones WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, response.body.data.id],
    );
    expect(rows[0]?.outlet_id).toBe(tenant.outletId);
  });

  it("status change on an outlet-2 table with an outlet-1 token is refused (404, the table is outside the token's reach) and the table stays", async () => {
    const token = await tokenFor(cashierB);
    const response = await call(
      "post",
      `/api/tables/${outlet2TableId}/status`,
      token,
      { action: "mark_dirty" },
    );
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const { rows } = await owner.query(
      "SELECT status FROM tables WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, outlet2TableId],
    );
    expect(rows[0]?.status).not.toBe("dirty");
  });
});

// ---- legend-42gqp: the outlet alias board is guarded like /api/floor --------
// Spec (docs/briefs/1006-so-akses-fix.md section 42gqp, SO 997 P1 #2):
// GET /api/outlets/:id/floor must apply the same shared-device rule as
// GET /api/floor: a session marked with a shared-flagged device (or a request
// carrying that device's token) needs a live X-Acting-Staff token, else 401
// ACTING_STAFF_REQUIRED. A cashier token is bound to its own outlet: it never
// opens another outlet's board.
//
// Assumptions:
//  - The session mark is written by SQL (`session.shared_device_ids`), as in
//    device-shared-mode.test.ts; the flag by `UPDATE devices SET shared_mode`.
//  - Cashier token of outlet A used on the alias of outlet B: the brief only
//    says "rejected", so any of 401/403/404 passes, but 200 and any board
//    payload fail. Outlet B is a second outlet in the same tenant.
//  - Cashier A on the alias of outlet A stays allowed per permission: 200 for
//    `till` (holds floor.table.view).
describe("shared device: outlet alias board (legend-42gqp)", () => {
  let outletB: string;
  const alias = (outletId: string) => `/api/outlets/${outletId}/floor`;

  beforeAll(async () => {
    outletB = randomUUID();
    const { rows } = await owner.query<{
      brand_id: string;
      legal_entity_id: string;
    }>("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
      tenant.outletId,
    ]);
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet B Uji', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
      [
        outletB,
        tenant.tenantId,
        rows[0]!.brand_id,
        rows[0]!.legal_entity_id,
        `OUTB-${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
  });

  async function newDevice(flagged: boolean): Promise<string> {
    const id = randomUUID();
    extraDevices.add(id);
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
      [id, tenant.tenantId, tenant.outletId, `Kasir Denah ${id.slice(0, 6)}`],
    );
    if (flagged)
      await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
        id,
      ]);
    return id;
  }

  const tokenOf = (deviceId: string) =>
    signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId,
    });

  async function markSession(who: Member, deviceId: string) {
    const { rowCount } = await owner.query(
      `UPDATE "session" SET shared_device_ids = ARRAY[$2]::uuid[] WHERE user_id = $1`,
      [who.userId, deviceId],
    );
    expect(rowCount).toBeGreaterThan(0);
  }

  /** `deviceId` null = browser without any device identity. */
  const get = (
    who: Member,
    path: string,
    deviceId: string | null,
    acting?: string,
  ) => {
    let request = who.client.get(path).set(headers);
    if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceId));
    if (acting) request = request.set(ACTING_HEADER, acting);
    return request;
  };

  async function cashierToken(
    who: Member,
    staff: Member,
    deviceId: string,
  ): Promise<string> {
    await setStaffPin(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      staff.userId,
      { outletId: tenant.outletId, userId: staff.userId },
      { pin: PIN },
    );
    const response = await who.client
      .post("/api/staff-pins/pos-session")
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
      .send({ userId: staff.userId, pin: PIN });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.token as string;
  }

  const expectNoBoard = (response: { body: unknown }) =>
    expect(
      (response.body as { data?: unknown }).data,
      JSON.stringify(response.body),
    ).toBeUndefined();

  it("legend-42gqp: marked owner session without a token on the alias is 401 ACTING_STAFF_REQUIRED", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Pemilik Tanda Denah", roles.till);
    await markSession(who, deviceId);
    const response = await get(who, alias(tenant.outletId), deviceId);
    expectError(response, 401, "ACTING_STAFF_REQUIRED");
    expectNoBoard(response);
  });

  it("legend-42gqp: marked owner session with the device header stripped is refused on the alias too", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Pemilik Cookie Denah", roles.till);
    await markSession(who, deviceId);
    const response = await get(who, alias(tenant.outletId), null);
    expectError(response, 401, "ACTING_STAFF_REQUIRED");
    expectNoBoard(response);
  });

  it("legend-42gqp: a flagged device token without a mark yet is refused on the alias", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Pemilik Baru Denah", roles.till);
    const response = await get(who, alias(tenant.outletId), deviceId);
    expectError(response, 401, "ACTING_STAFF_REQUIRED");
  });

  it("legend-42gqp: the same marked session is refused on /api/floor (baseline)", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Pemilik Tanda Floor", roles.till);
    await markSession(who, deviceId);
    const response = await get(who, "/api/floor", deviceId);
    expectError(response, 401, "ACTING_STAFF_REQUIRED");
    expectNoBoard(response);
    const stripped = await get(who, "/api/floor", null);
    expectError(stripped, 401, "ACTING_STAFF_REQUIRED");
  });

  it("legend-42gqp: a garbage token on the alias of a flagged device is ACTING_STAFF_INVALID", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Pemilik Token Rusak", roles.till);
    await markSession(who, deviceId);
    const response = await get(
      who,
      alias(tenant.outletId),
      deviceId,
      "pas_garbage-token",
    );
    expectError(response, 401, "ACTING_STAFF_INVALID");
  });

  it("legend-42gqp: a cashier of outlet A with a live token still opens the alias of outlet A", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Sesi Perangkat Denah", roles.till);
    const token = await cashierToken(who, cashierB, deviceId);
    const response = await get(who, alias(tenant.outletId), deviceId, token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.outletId).toBe(tenant.outletId);
  });

  it("legend-42gqp: a cashier token of outlet A is rejected on the alias of outlet B", async () => {
    const deviceId = await newDevice(true);
    const who = await member("Sesi Lintas Outlet", roles.till);
    const token = await cashierToken(who, cashierB, deviceId);
    const response = await get(who, alias(outletB), deviceId, token);
    expect([401, 403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expectNoBoard(response);
  });

  it("legend-42gqp: the guard is only on the floor GET; a cashier token of outlet A on another /api/outlets/B route is not touched by it", async () => {
    // Assumption: GET /api/outlets/:id/reservation-policy is a fall-through
    // outlet route. A router-level guard would answer the flagged-device
    // request WITHOUT X-Acting-Staff with 401 ACTING_STAFF_REQUIRED; the route
    // itself never does, so that code must not appear. With a token the
    // generic "unsupported endpoint" answer is not the guard's and is allowed;
    // the guard's own REQUIRED/INVALID codes are not.
    const deviceId = await newDevice(true);
    const who = await member("Sesi Rute Lain Outlet", roles.till);
    const token = await cashierToken(who, cashierB, deviceId);
    const path = `/api/outlets/${outletB}/reservation-policy`;
    const withToken = await get(who, path, deviceId, token);
    const without = await get(who, path, deviceId);
    const code = (r: { body: unknown }) =>
      (r.body as { error?: { code?: string } }).error?.code ?? "";
    expect(code(without), JSON.stringify(without.body)).not.toMatch(
      /^(ACTING_STAFF_|SHARED_DEVICE_)/,
    );
    expect(
      ["ACTING_STAFF_REQUIRED", "ACTING_STAFF_INVALID"],
      JSON.stringify(withToken.body),
    ).not.toContain(code(withToken));
    // The floor GET alias of the cashier's own outlet still passes with a live token.
    const board = await get(who, alias(tenant.outletId), deviceId, token);
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(board.body.data.outletId).toBe(tenant.outletId);
  });

  it("legend-42gqp: a private (unflagged) device owner is unaffected on both board routes", async () => {
    const deviceId = await newDevice(false);
    const who = await member("Pemilik Perangkat Pribadi", roles.till);
    const board = await get(who, alias(tenant.outletId), deviceId);
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(board.body.data.outletId).toBe(tenant.outletId);
    const current = await get(who, "/api/floor", deviceId);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    // A plain browser without any device identity keeps working as well.
    const browser = await get(who, alias(tenant.outletId), null);
    expect(browser.status, JSON.stringify(browser.body)).toBe(200);
  });

  it("legend-42gqp: another tenant is untouched by a flagged device elsewhere", async () => {
    await newDevice(true);
    const other = await staffWithRole(app, { template: "owner" });
    const board = await other.client.get(alias(seededOutletA));
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(board.body.data.outletId).toBe(seededOutletA);
    const current = await other.client.get("/api/floor");
    expect(current.status, JSON.stringify(current.body)).toBe(200);
  });
});
