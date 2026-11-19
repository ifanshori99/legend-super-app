// legend-iq0jz (sub-1043, ported onto the 1027/1054 guard design in sub-1094):
// a session marked for a shared device (session.shared_device_ids; a mark never
// lapses) that reaches a router opted in with requireAuthAllowSharedDevice may
// only use POS/kasir (incl. reservasi), floor, KDS and Tanya AI at KDS routes
// (founder Q29, 18 Nov). Any other route of an opted-in router answers
// 403 SHARED_DEVICE_SCREEN_CLOSED (default deny). A router that did not opt in
// is refused earlier with 403 ACTING_STAFF_NOT_ALLOWED (unchanged). Personal
// devices (no mark) are never affected. GET /api/me/access reports
// `sharedDevice`.
//
// Assumptions:
//  - Open routes are only asserted as "not SHARED_DEVICE_SCREEN_CLOSED and not
//    5xx"; their own handler may still answer 400/401/403/404.
//  - Closed routes are the routes of opted-in routers that no screen uses
//    (floor editor, zone waiters, open-bill policy write, menu availability
//    edit, delivery orders). The closed check runs before permission and body
//    validation, so POST bodies may be empty.
//  - The mark is set by one request with the device header; the test asserts
//    the mark in the DB. /api/auth/* keeps its own guard
//    (shared-device-auth.ts) and is covered by auth-shared-device-guard.test.ts.
//  - The pure unit cases call `isSharedDeviceApiAllowed(method, path)`.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const CLOSED_CODE = "SHARED_DEVICE_SCREEN_CLOSED";

type Client = ReturnType<typeof agent>;
type Method = "get" | "post" | "put" | "patch" | "delete";
type Member = { client: Client; userId: string };
type Res = { status: number; body: unknown };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let host: { Host: string };
let hostB: { Host: string };
let sharedDevice: string;
let personalDevice: string;
const till = randomUUID();
const knownDevices = new Set<string>();

async function member(label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, till],
  );
  return { client, userId };
}

const tokenFor = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function newDevice(shared: boolean): Promise<string> {
  const id = randomUUID();
  knownDevices.add(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, tenant.tenantId, tenant.outletId, `Tablet Uji ${id.slice(0, 6)}`],
  );
  if (shared) await setFlag(id, true);
  return id;
}

const setFlag = (id: string, value: boolean) =>
  owner.query("UPDATE devices SET shared_mode = $2 WHERE id = $1", [id, value]);

async function sessionMark(userId: string): Promise<string[]> {
  const { rows } = await owner.query<{ shared_device_ids: string[] }>(
    `SELECT shared_device_ids::text[] AS shared_device_ids FROM "session" WHERE user_id = $1`,
    [userId],
  );
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!.shared_device_ids;
}

type Call = {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
};

/** Sends the call; `deviceId` adds that device's token header, `null` sends none. */
async function send(
  who: Member,
  call: Call,
  deviceId: string | null,
  hostHeader: { Host: string } = host,
): Promise<Res> {
  let request = who.client[call.method](call.path)
    .set(hostHeader)
    .set(originHeader);
  if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenFor(deviceId));
  return call.method === "get" ? request : request.send(call.body ?? {});
}

function expectClosed(response: Res) {
  const body = response.body as { error?: { code?: string; message?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(CLOSED_CODE);
  expect(body.error?.message ?? "").not.toBe("");
}

function expectNotClosed(response: Res) {
  const body = response.body as { error?: { code?: string } };
  expect(body.error?.code, JSON.stringify(response.body)).not.toBe(CLOSED_CODE);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
}

/** One request from the shared device header marks the login session. */
async function markSession(who: Member, deviceId: string) {
  await send(
    who,
    { method: "get", path: `${outletBase()}/pos/parked-orders` },
    deviceId,
  );
  expect(await sessionMark(who.userId)).toEqual([deviceId]);
}

const outletBase = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}`;

// ---- route tables --------------------------------------------------------------

type Entry = [name: string, build: () => Call];

const OPEN: Entry[] = [
  [
    "reservasi: GET reservations",
    () => ({ method: "get", path: `${outletBase()}/reservations` }),
  ],
  [
    "kds: GET kitchen/stations",
    () => ({ method: "get", path: `${outletBase()}/kitchen/stations` }),
  ],
  [
    "kds: POST station heartbeat",
    () => ({
      method: "post",
      path: `${outletBase()}/kitchen/stations/${randomUUID()}/heartbeat`,
    }),
  ],
  [
    "kds 86: GET menu availability",
    () => ({
      method: "get",
      path: `/api/menu/availability?outletId=${encodeURIComponent(tenant.outletId)}`,
    }),
  ],
  [
    "kds 86: POST menu availability status",
    () => ({
      method: "post",
      path: `/api/menu/availability/${randomUUID()}/status`,
    }),
  ],
  [
    "pos: GET parked-orders",
    () => ({ method: "get", path: `${outletBase()}/pos/parked-orders` }),
  ],
  [
    "pos: POST orders",
    () => ({ method: "post", path: `${outletBase()}/pos/orders` }),
  ],
  [
    "pos: POST staff-pins/pos-session",
    () => ({ method: "post", path: "/api/staff-pins/pos-session" }),
  ],
  [
    "floor: GET outlet floor",
    () => ({ method: "get", path: `${outletBase()}/floor` }),
  ],
  [
    "floor: POST table-links",
    () => ({ method: "post", path: "/api/table-links" }),
  ],
  [
    "floor: POST table-sessions close",
    () => ({
      method: "post",
      path: `/api/table-sessions/${randomUUID()}/close`,
    }),
  ],
  [
    "kasir: POST order-issue-charges collect-at-pos",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/collect-at-pos`,
    }),
  ],
  [
    "shell: GET /api/me/access",
    () => ({ method: "get", path: "/api/me/access" }),
  ],
  [
    "shell: GET /api/identity/push-devices",
    () => ({ method: "get", path: "/api/identity/push-devices" }),
  ],
];

/** Routes of opted-in routers that no shared-tablet screen uses. */
const CLOSED: Entry[] = [
  [
    "kasir: POST apology-vouchers (issue closed on a shared tablet)",
    () => ({ method: "post", path: "/api/apology-vouchers" }),
  ],
  [
    "floor editor: POST /api/floor/zones",
    () => ({ method: "post", path: "/api/floor/zones" }),
  ],
  [
    "floor editor: PUT /api/floor/layout",
    () => ({ method: "put", path: "/api/floor/layout" }),
  ],
  [
    "floor: POST table qr/rotate",
    () => ({ method: "post", path: `/api/tables/${randomUUID()}/qr/rotate` }),
  ],
  [
    "service request: POST zone waiters (setup)",
    () => ({
      method: "post",
      path: `${outletBase()}/zones/${randomUUID()}/waiters`,
    }),
  ],
  [
    "open bill: PUT policy (settings)",
    () => ({ method: "put", path: `${outletBase()}/open-bill-policy` }),
  ],
  [
    "menu: PATCH availability edit",
    () => ({
      method: "patch",
      path: `/api/menu/availability/${randomUUID()}`,
    }),
  ],
  [
    "kds: PUT stations (kitchen setup)",
    () => ({ method: "put", path: `${outletBase()}/kitchen/stations` }),
  ],
  [
    // Guest picks the dearer swap via customer-choice, then waive/expire gives
    // the item free.
    "kasir: POST order-issue-charges waive (uang, DENY)",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/waive`,
    }),
  ],
  [
    "kasir: POST order-issue-charges expire (uang, DENY)",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/expire`,
    }),
  ],
  [
    "kasir: POST order-issue-charges refund (keputusan founder, default tolak)",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/refund`,
    }),
  ],
  [
    // Round 3: the `pos/*` wildcard must not open the refund correction (money).
    "pos: POST orders/:id/corrections/refund (uang, DENY sebelum wildcard pos)",
    () => ({
      method: "post",
      path: `${outletBase()}/pos/orders/${randomUUID()}/corrections/refund`,
    }),
  ],
  [
    // Round 3b: a cash void of a paid order pays the cash back out (Q63).
    "pos: POST orders/:id/corrections/void (uang tunai keluar, DENY sebelum wildcard pos)",
    () => ({
      method: "post",
      path: `${outletBase()}/pos/orders/${randomUUID()}/corrections/void`,
    }),
  ],
  [
    "default tolak: GET outlet delivery-orders (di luar semua grup)",
    () => ({ method: "get", path: `${outletBase()}/delivery-orders` }),
  ],
];

/** Routers that did not opt in: the base guard answers ACTING_STAFF_NOT_ALLOWED. */
const BACKOFFICE: Entry[] = [
  [
    "operasional: GET checklist-templates",
    () => ({ method: "get", path: "/api/operations/checklist-templates" }),
  ],
  [
    "fasilitas: POST areas",
    () => ({ method: "post", path: "/api/facility/areas" }),
  ],
  [
    "inventori: GET balances",
    () => ({ method: "get", path: "/api/inventory/balances" }),
  ],
];

// ---- fixtures ------------------------------------------------------------------

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`sda-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`sdb-${randomUUID().slice(0, 6)}`);
  host = { Host: tenant.hostname };
  hostB = { Host: tenantB.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && knownDevices.has(deviceId)
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Tablet Bersama', false, NULL, $3, false, '["tenant"]')`,
    [
      till,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
        "floor.table.view",
        "floor.table.operate",
        "kds.ticket.process",
      ]),
    ],
  );
  sharedDevice = await newDevice(true);
  personalDevice = await newDevice(false);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  for (const t of [tenant, tenantB]) {
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  }
  await owner.end();
});

// ---- on a shared tablet --------------------------------------------------------

function expectNotAllowed(response: Res) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(
    "ACTING_STAFF_NOT_ALLOWED",
  );
}

const accessFlag = (response: Res) =>
  (response.body as { data: { sharedDevice?: boolean } }).data.sharedDevice;

type Mode = {
  name: string;
  prepare: () => Promise<Member>;
  deviceFor: () => string | null;
};

const MODES: Mode[] = [
  {
    name: "header X-Device-Token of a shared device",
    prepare: () => member("Tablet Header"),
    deviceFor: () => sharedDevice,
  },
  {
    name: "login cookie marked by a shared device, no header",
    prepare: async () => {
      const who = await member("Tablet Cookie");
      await markSession(who, sharedDevice);
      return who;
    },
    deviceFor: () => null,
  },
];

describe.each(MODES)("legend-iq0jz on a shared tablet: $name", (mode) => {
  let who: Member;
  beforeAll(async () => {
    who = await mode.prepare();
  });

  it.each(OPEN)("%s is not closed", async (_name, build) => {
    expectNotClosed(await send(who, build(), mode.deviceFor()));
  });

  it.each(CLOSED)(
    "%s answers 403 SHARED_DEVICE_SCREEN_CLOSED",
    async (_name, build) => {
      expectClosed(await send(who, build(), mode.deviceFor()));
    },
  );

  it.each(BACKOFFICE)(
    "%s keeps the base refusal ACTING_STAFF_NOT_ALLOWED",
    async (_name, build) => {
      expectNotAllowed(await send(who, build(), mode.deviceFor()));
    },
  );

  it("GET /api/me/access answers 200 and says sharedDevice: true", async () => {
    const response = await send(
      who,
      { method: "get", path: "/api/me/access" },
      mode.deviceFor(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(accessFlag(response)).toBe(true);
  });
});

// ---- personal devices and other edge cases ------------------------------------

describe("legend-iq0jz personal devices stay fully open", () => {
  it.each([...OPEN, ...CLOSED, ...BACKOFFICE])(
    "%s: a clean session without a device header is never closed",
    async (_name, build) => {
      const who = await member("Pribadi Bersih");
      expect(await sessionMark(who.userId)).toEqual([]);
      const response = await send(who, build(), null);
      expectNotClosed(response);
      expect(
        (response.body as { error?: { code?: string } }).error?.code,
      ).not.toBe("ACTING_STAFF_NOT_ALLOWED");
    },
  );

  it.each(CLOSED)(
    "%s: the token of an unflagged device does not close it",
    async (_name, build) => {
      const who = await member("Pribadi Perangkat");
      expectNotClosed(await send(who, build(), personalDevice));
      expect(await sessionMark(who.userId)).toEqual([]);
    },
  );

  it("GET /api/me/access says sharedDevice: false for a clean session and for an unflagged device", async () => {
    const who = await member("Pribadi Akses");
    for (const device of [null, personalDevice]) {
      const response = await send(
        who,
        { method: "get", path: "/api/me/access" },
        device,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(accessFlag(response)).toBe(false);
    }
  });

  it("a garbage X-Device-Token from a clean session never throws and is not closed", async () => {
    const who = await member("Token Rusak");
    const response = await who.client
      .get(`${outletBase()}/delivery-orders`)
      .set(host)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, "garbage.token.value");
    expectNotClosed(response);
  });
});

describe("legend-iq0jz the mark never lapses (legend 1027)", () => {
  it("unflagging the device keeps the opted-in closed routes closed for the same cookie", async () => {
    const id = await newDevice(true);
    const who = await member("Tanda Tetap");
    await markSession(who, id);
    await setFlag(id, false);
    expectClosed(
      await send(
        who,
        { method: "get", path: `${outletBase()}/delivery-orders` },
        null,
      ),
    );
    expect(await sessionMark(who.userId)).toEqual([id]);
  });

  it("a marked session of tenant A calling a closed route with the Host of tenant B is refused with 403", async () => {
    const who = await member("Lintas Tenant");
    await markSession(who, sharedDevice);
    const response = await send(
      who,
      { method: "get", path: `${outletBase()}/delivery-orders` },
      null,
      hostB,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });
});

// ---- pure unit: isSharedDeviceApiAllowed ---------------------------------------

describe("legend-iq0jz isSharedDeviceApiAllowed", () => {
  const load = async () => import("../lib/shared-device-allowlist.ts");
  const o = randomUUID();

  const allowed: [string, string][] = [
    ["GET", `/api/outlets/${o}/pos/catalog`],
    ["POST", `/api/outlets/${o}/pos/orders`],
    ["GET", `/api/outlets/${o}/reservations`],
    ["POST", `/api/outlets/${o}/reservations/${randomUUID()}/seat`],
    ["GET", `/api/outlets/${o}/kitchen/stations`],
    ["POST", `/api/outlets/${o}/kitchen/tickets/${randomUUID()}/bump`],
    ["GET", `/api/outlets/${o}/floor`],
    ["POST", "/api/staff-pins/pos-session"],
    ["POST", `/api/order-issue-charges/${randomUUID()}/collect-at-pos`],
    ["GET", "/api/apology-vouchers/ABC123"],
    ["POST", "/api/table-links"],
    ["POST", `/api/table-sessions/${randomUUID()}/close`],
    ["GET", "/api/me/access"],
    ["POST", "/api/auth/sessions/current/activity"],
    ["GET", "/api/identity/push-devices"],
    ["DELETE", `/api/notifications/push-subscriptions/${randomUUID()}`],
    // Normalisation: case, one trailing slash and a query.
    ["GET", `/API/Outlets/${o}/POS/catalog`],
    ["GET", `/api/outlets/${o}/pos/catalog/`],
    ["GET", `/api/outlets/${o}/floor?x=1`],
  ];

  const closed: [string, string][] = [
    ["POST", "/api/apology-vouchers"],
    ["POST", "/api/apology-vouchers/"],
    ["GET", "/api/operations/checklist-templates"],
    ["GET", "/api/hris/announcements"],
    ["POST", "/api/facility/areas"],
    ["POST", "/api/wifi/sessions"],
    ["GET", "/api/notifications"],
    ["GET", "/api/ai/governance"],
    ["GET", "/api/ai/kds"],
    ["POST", "/api/ai/kds/anything"],
    ["POST", `/api/outlets/${o}/pos/orders/${randomUUID()}/corrections/refund`],
    ["POST", `/api/outlets/${o}/pos/orders/${randomUUID()}/corrections/void`],
    [
      "POST",
      `/api/outlets/${o}/pos/orders/${randomUUID()}/corrections/refund/`,
    ],
    ["POST", `/API/Outlets/${o}/POS/orders/${randomUUID()}/corrections/refund`],
    ["GET", "/api/inventory/balances"],
    ["GET", `/api/outlets/${o}/delivery-orders`],
    ["POST", "/api/floor/zones"],
    ["PUT", "/api/floor/layout"],
    ["POST", `/api/tables/${randomUUID()}/qr/rotate`],
    ["PUT", `/api/outlets/${o}/open-bill-policy`],
    ["PATCH", `/api/menu/availability/${randomUUID()}`],
    ["PUT", `/api/outlets/${o}/kitchen/stations`],
    ["POST", `/api/order-issue-charges/${randomUUID()}/waive`],
    ["POST", `/api/order-issue-charges/${randomUUID()}/expire`],
    ["GET", `/api/order-issue-charges/${randomUUID()}/waive`],
    ["GET", `/api/order-issue-charges/${randomUUID()}`],
    ["DELETE", `/api/identity/push-devices/${randomUUID()}`],
    ["GET", "/"],
    ["GET", ""],
    // Whole-segment matching, anchored patterns.
    ["GET", `/api/outlets/${o}/posx`],
    ["GET", `/api/outlets/${o}/posx/catalog`],
    ["GET", "/api/me/accessx"],
    ["GET", `/prefix/api/outlets/${o}/pos/catalog`],
    // Traversal, encoded separators, double slash, backslash.
    ["GET", `/api/outlets/${o}/pos/../operations`],
    ["GET", `/api/outlets/${o}/pos/%2e%2e/operations`],
    ["GET", `/api/outlets/${o}/pos/%2E%2E/operations`],
    ["GET", `/api/outlets/${o}/pos%2fcatalog`],
    ["GET", `/api/outlets/${o}/pos%5Ccatalog`],
    ["GET", `/api/outlets/${o}//pos/catalog`],
    ["GET", `//api/outlets/${o}/pos/catalog`],
    ["GET", `/api/outlets/${o}/pos\\catalog`],
    // Shell and keep-alive are exact verbs.
    ["POST", "/api/me/access"],
    ["GET", "/api/auth/sessions/current/activity"],
    ["POST", "/api/identity/push-devices"],
  ];

  it.each(allowed)("allows %s %s", async (method, path) => {
    const { isSharedDeviceApiAllowed } = await load();
    expect(isSharedDeviceApiAllowed(method, path)).toBe(true);
  });

  it.each(closed)("closes %s %s", async (method, path) => {
    const { isSharedDeviceApiAllowed } = await load();
    expect(isSharedDeviceApiAllowed(method, path)).toBe(false);
  });
});
