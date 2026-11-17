// legend-3z0ds (brief 1012): a login session that touched a shared (cashier)
// device must not reach back-office routers, and POS routers on it need a
// cashier token. Written from the card brief, not from the implementation.
//
// Rules under test:
//  - `requireAuth` is default-deny: a session that is marked as used on an active
//    flagged shared device (session.shared_device_ids), OR a request that carries
//    the X-Device-Token of an active flagged device, is refused 403
//    ACTING_STAFF_NOT_ALLOWED on every back-office router. A valid X-Acting-Staff
//    header does not lift that.
//  - POS routers stay reachable: no cashier token -> 401 ACTING_STAFF_REQUIRED;
//    with a live cashier token the request passes the guard.
//  - SHELL route GET /api/me/access still answers 200 for a marked session.
//  - Personal devices (never marked, or every mark lapsed) keep the old behaviour.
//
// Assumptions:
//  - Back-office representatives (one per router group): accounting
//    GET /api/accounting/asset-categories, inventory GET /api/inventory/suppliers,
//    hris GET /api/hris/employees, org GET /api/org/brands, access GET
//    /api/access/roles. /api/platform/* is not used: it needs a platform admin and
//    adds no shared-device coverage beyond these.
//  - The member holds the seeded `owner` template in the seeded tenant (back
//    office) and a POS role in an isolated tenant (devices, POS routes). The
//    session is MFA-verified before it is marked, so a refusal can only come from
//    the shared-device guard.
//  - "Not blocked" for the private-device cases means: no 401 and no
//    ACTING_STAFF_* code. Only GET /api/org/brands is asserted 200 (a permission
//    answer of another route is not the concern of this file).
//  - POS representatives: GET /api/outlets/:o/pos/parked-orders, /api/outlets/:o/expo,
//    /api/outlets/:o/pickup-display, /api/menu/availability. GET /api/notifications is
//    SHELL (no cashier token needed); only "not stopped by the gate" is asserted.
//  - A device token carries its tenant: requests with one use the Host of that tenant
//    (seeded-tenant devices for seeded back-office calls, POS-tenant devices otherwise).
//    "Passes the guard" with a token = no 401 and no ACTING_STAFF_* code (the
//    handler or permission check may answer anything else).
//  - Marking uses `markSessionSharedDevice(sessionId, deviceId)`.
//  - The cashier token comes from POST /api/staff-pins/pos-session sent by the
//    marked session itself with the device token (a SHELL route).
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const NOT_ALLOWED = "ACTING_STAFF_NOT_ALLOWED";
const REQUIRED = "ACTING_STAFF_REQUIRED";
const PIN = "582914";
const POS_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "shift.cash.operate",
  "floor.table.view",
  "floor.table.operate",
  "floor.table.manage",
  "kds.ticket.process",
  "kds.station.manage",
];

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string; sessionId: string };
type Res = { status: number; body: unknown };

let app: Express;
let tenant: IsolatedTenant;
let posRoleId: string;
let cashier: Member;
// device id -> tenant/outlet it is registered in. A device token carries its tenant,
// so a request with that token must use the Host of the same tenant (else the
// answer is TENANT_MISMATCH before the shared-device guard is even the question).
const knownDevices = new Map<string, { tenantId: string; outletId: string }>();

const BACKOFFICE_ROUTES: Array<{ group: string; path: string }> = [
  { group: "accounting", path: "/api/accounting/asset-categories" },
  { group: "inventory", path: "/api/inventory/suppliers" },
  { group: "hris", path: "/api/hris/employees" },
  { group: "org", path: "/api/org/brands" },
  { group: "access", path: "/api/access/roles" },
];

const outletBase = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}`;
const POS_ROUTES: Array<{ group: string; path: () => string }> = [
  {
    group: "pos-parked-order",
    path: () => `${outletBase()}/pos/parked-orders`,
  },
  { group: "expo", path: () => `${outletBase()}/expo` },
  { group: "pickup", path: () => `${outletBase()}/pickup-display` },
  { group: "menu", path: () => "/api/menu/availability" },
];

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: knownDevices.get(deviceId)!.tenantId,
    brandId: null,
    deviceId,
  });

async function sessionIdOf(userId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM "session" WHERE user_id = $1`,
    [userId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function assignPosRole(userId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, posRoleId],
  );
}

/** A fresh login: owner in the seeded tenant, POS role in the isolated tenant. */
async function member(label: string): Promise<Member> {
  const staff = await staffWithRole(app, { template: "owner", label });
  await assignPosRole(staff.userId);
  await verifySessionMfa(staff.email);
  return {
    client: staff.client,
    userId: staff.userId,
    sessionId: await sessionIdOf(staff.userId),
  };
}

/** "pos" = device of the isolated tenant; "seeded" = device of the seeded tenant. */
async function newDevice(
  flagged: boolean,
  home: "pos" | "seeded" = "pos",
): Promise<string> {
  const id = randomUUID();
  const place =
    home === "pos"
      ? { tenantId: tenant.tenantId, outletId: tenant.outletId }
      : { tenantId: seededTenantId, outletId: seededOutletA };
  knownDevices.set(id, place);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, place.tenantId, place.outletId, `Kasir 1012 ${id.slice(0, 6)}`],
  );
  if (flagged) await setFlag(id, true);
  return id;
}

const setFlag = (id: string, value: boolean) =>
  owner.query("UPDATE devices SET shared_mode = $2 WHERE id = $1", [id, value]);

/** A marked session: one flagged device stamped on a fresh login. */
async function markedMember(label: string) {
  const device = await newDevice(true);
  const who = await member(label);
  expect(await markSessionSharedDevice(who.sessionId, device)).toBe(true);
  return { who, device };
}

function backoffice(
  who: Member,
  path: string,
  extra: Record<string, string> = {},
  host: string = seededHostname,
) {
  return who.client.get(path).set({ Host: host }).set(originHeader).set(extra);
}

function pos(who: Member, path: string, extra: Record<string, string> = {}) {
  return who.client
    .get(path)
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(extra);
}

const codeOf = (response: Res) =>
  (response.body as { error?: { code?: string } }).error?.code ?? "";

function expectNotAllowed(response: Res) {
  const body = response.body as { error?: { message?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(NOT_ALLOWED);
  expect(body.error?.message ?? "").not.toBe("");
}

function expectRequired(response: Res) {
  const body = response.body as { error?: { message?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(401);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(REQUIRED);
  expect(body.error?.message ?? "").not.toBe("");
}

/** The shared-device guard did not refuse the request. */
function expectNotGuarded(response: Res) {
  expect(response.status, JSON.stringify(response.body)).not.toBe(401);
  expect(
    codeOf(response).startsWith("ACTING_STAFF_"),
    JSON.stringify(response.body),
  ).toBe(false);
}

/** Cashier token issued on `device` by the (marked) session `who`. */
async function cashierToken(who: Member, device: string): Promise<string> {
  const response = await who.client
    .post("/api/staff-pins/pos-session")
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(device))
    .send({ userId: cashier.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`bo-${randomUUID().slice(0, 6)}`);
  posRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Backoffice Guard', false, NULL, $3, false, '["tenant"]')`,
    [posRoleId, tenant.tenantId, JSON.stringify(POS_PERMISSIONS)],
  );
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    const place = knownDevices.get(deviceId);
    return place && place.tenantId === tenantId ? place.outletId : null;
  });
  // The cashier whose token is issued; a plain login holding the POS role.
  const client = agent(app);
  await signUp(client, "Kasir Token 1012");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await assignPosRole(userId);
  cashier = { client, userId, sessionId: await sessionIdOf(userId) };
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    { outletId: tenant.outletId, userId: cashier.userId },
    { pin: PIN },
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("DELETE FROM staff_pins WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM pos_acting_staff WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    [...knownDevices.keys()],
  ]);
  await dropIsolatedTenant(tenant);
  await owner.end();
});

describe("1012 marked session on back-office routers", () => {
  it.each(BACKOFFICE_ROUTES)(
    "refuses a marked session without a cashier header on $group ($path) with ACTING_STAFF_NOT_ALLOWED",
    async ({ path }) => {
      const { who } = await markedMember("Sesi Bertanda Backoffice");
      expectNotAllowed(await backoffice(who, path));
    },
  );

  it.each(BACKOFFICE_ROUTES)(
    "a valid X-Acting-Staff header does not lift the refusal on $group ($path)",
    async ({ path }) => {
      const { who, device } = await markedMember("Sesi Bertanda Header Kasir");
      const token = await cashierToken(who, device);
      // The cashier token belongs to the POS tenant, so the request uses that
      // tenant's Host; the shared-device refusal comes before any permission check.
      expectNotAllowed(
        await backoffice(
          who,
          path,
          { [ACTING_HEADER]: token },
          tenant.hostname,
        ),
      );
      // Together with the device token as well.
      expectNotAllowed(
        await backoffice(
          who,
          path,
          { [ACTING_HEADER]: token, [DEVICE_TOKEN_HEADER]: tokenOf(device) },
          tenant.hostname,
        ),
      );
    },
  );

  it("an unmarked session sending a flagged device's token to a back-office router is refused 403 and the session becomes marked", async () => {
    const device = await newDevice(true, "seeded");
    const who = await member("Sesi Belum Bertanda Header");
    // Not marked yet: the back office is open for it.
    const before = await backoffice(who, "/api/org/brands");
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    expectNotAllowed(
      await backoffice(who, "/api/org/brands", {
        [DEVICE_TOKEN_HEADER]: tokenOf(device),
      }),
    );
    // The mark sticks: the cookie alone is now refused too.
    expectNotAllowed(await backoffice(who, "/api/org/brands"));
    const { rows } = await owner.query<{ ids: string[] }>(
      `SELECT shared_device_ids::text[] AS ids FROM "session" WHERE id = $1`,
      [who.sessionId],
    );
    expect(rows[0]!.ids).toContain(device);
  });
});

describe("1012 marked session on POS routers", () => {
  it.each(POS_ROUTES)(
    "needs a cashier token on $group: 401 ACTING_STAFF_REQUIRED without it",
    async ({ path }) => {
      const { who } = await markedMember("Sesi Bertanda POS Tanpa Token");
      expectRequired(await pos(who, path()));
    },
  );

  it.each(POS_ROUTES)(
    "passes the guard on $group with a live cashier token",
    async ({ path }) => {
      const { who, device } = await markedMember("Sesi Bertanda POS Token");
      const token = await cashierToken(who, device);
      expectNotGuarded(
        await pos(who, path(), {
          [ACTING_HEADER]: token,
          [DEVICE_TOKEN_HEADER]: tokenOf(device),
        }),
      );
    },
  );
});

describe("1012 shell route and personal devices", () => {
  it("GET /api/me/access stays 200 for a marked session", async () => {
    const { who } = await markedMember("Sesi Bertanda Shell");
    const response = await who.client.get("/api/me/access").set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("GET /api/identity/push-devices is shell: a marked session is not stopped by the shared-device gate, with or without a cashier token", async () => {
    const { who, device } = await markedMember("Sesi Bertanda Notifikasi");
    expectNotGuarded(await pos(who, "/api/identity/push-devices"));
    const token = await cashierToken(who, device);
    expectNotGuarded(
      await pos(who, "/api/identity/push-devices", {
        [ACTING_HEADER]: token,
        [DEVICE_TOKEN_HEADER]: tokenOf(device),
      }),
    );
  });

  it("a never-marked session on a personal device keeps every back-office router open", async () => {
    // A flagged device exists in the tenant, but this login never touched it.
    await newDevice(true);
    const who = await member("Sesi Pribadi");
    const brands = await backoffice(who, "/api/org/brands");
    expect(brands.status, JSON.stringify(brands.body)).toBe(200);
    for (const { path } of BACKOFFICE_ROUTES) {
      expectNotGuarded(await backoffice(who, path));
    }
  });

  it("an unflagged device's token does not mark the session or close the back office", async () => {
    const plain = await newDevice(false, "seeded");
    const who = await member("Sesi Perangkat Biasa");
    const response = await backoffice(who, "/api/org/brands", {
      [DEVICE_TOKEN_HEADER]: tokenOf(plain),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await backoffice(who, "/api/org/brands");
    expect(after.status, JSON.stringify(after.body)).toBe(200);
  });

  it("a lapsed mark (device unflagged) opens the back office again", async () => {
    const { who, device } = await markedMember("Sesi Tanda Lapuk");
    expectNotAllowed(await backoffice(who, "/api/org/brands"));

    await setFlag(device, false);
    const reopened = await backoffice(who, "/api/org/brands");
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    for (const { path } of BACKOFFICE_ROUTES) {
      expectNotGuarded(await backoffice(who, path));
    }
  });
});
