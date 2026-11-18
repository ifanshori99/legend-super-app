// legend-iq0jz (sub-1043): shared tablets only open POS/kasir (incl. reservasi),
// floor, KDS and Tanya AI at KDS; everything else is closed by default.
// Spec = docs/briefs/sub-1043-allowlist.md (founder Q29, 18 Nov).
//
// Rule under test: a request is "on a shared tablet" when (a) it carries a valid
// X-Device-Token of an active device flagged `shared_mode`, or (b) its login
// session is marked (`session.shared_device_ids`) for a still-active shared
// device. On a shared tablet a path outside the allowlist answers
// 403 SHARED_DEVICE_SCREEN_CLOSED. Personal devices (clean session, no flagged
// device) are never affected. `GET /api/me/access` reports `sharedDevice`.
//
// Assumptions (the brief leaves these open):
//  - Section D: KDS "86" calls (GET /api/menu/availability?outletId=..,
//    POST /api/menu/availability/:id/status) are open. /api/auth/* is guarded in
//    app.ts, not requireAuth; on a shared tablet only get-session, sign-in/*,
//    sign-out and two-factor/verify-* stay open, the rest answers the closed
//    code. sign-out is tested on a throw-away session (it destroys the cookie).
//    `isSharedDeviceAuthAllowed(method, path)` takes the same arguments as
//    `isSharedDeviceApiAllowed` (path without query); only method-agnostic
//    facts plus the natural verbs (sign-in POST, get-session GET, sign-out
//    POST, verify POST) are asserted.
//  - GET /api/ai/guidelines is static page content of Tanya AI "panduan"
//    (/kds/tanya-ai/panduan stays open), so it is in neither list.
//  - Allowed routes are only asserted as "not closed" (not 403
//    SHARED_DEVICE_SCREEN_CLOSED and not 5xx). They may still answer 400/403
//    PERMISSION_DENIED/ACTING_STAFF_REQUIRED/404 from their own handler.
//  - Closed routes are one representative route per family (operations, hris,
//    facility, wifi, notifications, ai governance/provider, inventory) plus an outlet route outside every group (delivery-orders) to
//    prove default-deny. The closed check runs before permission and body
//    validation, so POST bodies may be empty.
//  - The mark is set by sending one request with the device header (same way
//    acting-staff-shared-device.test.ts does); the test asserts the mark in the
//    DB so a setup problem never hides behind a green result.
//  - A marked session of tenant A calling tenant B's operations (Host of B)
//    answers the same SHARED_DEVICE_SCREEN_CLOSED 403: the closed check sits in
//    requireAuth, before tenant membership is looked at.
//  - A broken X-Device-Token never throws in the allowlist: a clean session
//    sending garbage is treated as "not on a shared device" (status < 500, not
//    the closed code).
//  - The pure unit cases call `isSharedDeviceApiAllowed(method, path)` from
//    `src/lib/shared-device-allowlist.ts` (dynamic import, so a missing module
//    fails only those cases, not the HTTP cases).

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
    "reservasi: GET reservation-policy",
    () => ({ method: "get", path: `${outletBase()}/reservation-policy` }),
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
    "pos: GET catalog",
    () => ({ method: "get", path: `${outletBase()}/pos/catalog` }),
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
  ["ai: POST /api/ai/ask", () => ({ method: "post", path: "/api/ai/ask" })],
  [
    "ai: GET /api/ai/conversations",
    () => ({ method: "get", path: "/api/ai/conversations" }),
  ],
  [
    "ai: GET /api/ai/conversations/:id",
    () => ({ method: "get", path: `/api/ai/conversations/${randomUUID()}` }),
  ],
  ["ai: GET /api/ai/usage", () => ({ method: "get", path: "/api/ai/usage" })],
  ["ai: GET /api/ai/tools", () => ({ method: "get", path: "/api/ai/tools" })],
  [
    "shell: GET /api/me/access",
    () => ({ method: "get", path: "/api/me/access" }),
  ],
];

const CLOSED: Entry[] = [
  [
    "operasional: GET checklist-templates",
    () => ({ method: "get", path: "/api/operations/checklist-templates" }),
  ],
  [
    "operasional: POST checklist-runs",
    () => ({ method: "post", path: "/api/operations/checklist-runs" }),
  ],
  [
    "hris: GET announcements",
    () => ({ method: "get", path: "/api/hris/announcements" }),
  ],
  [
    "fasilitas: POST areas",
    () => ({ method: "post", path: "/api/facility/areas" }),
  ],
  [
    "wifi: POST sessions",
    () => ({ method: "post", path: "/api/wifi/sessions" }),
  ],
  [
    "notifikasi: GET /api/notifications",
    () => ({ method: "get", path: "/api/notifications" }),
  ],
  [
    "notifikasi: GET preferences",
    () => ({ method: "get", path: "/api/notifications/preferences" }),
  ],
  ["ai: GET governance", () => ({ method: "get", path: "/api/ai/governance" })],
  ["ai: GET provider", () => ({ method: "get", path: "/api/ai/provider" })],
  [
    "inventori: GET balances",
    () => ({ method: "get", path: "/api/inventory/balances" }),
  ],
  [
    "kasir: POST order-issue-charges refund (only collect-at-pos is open)",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/refund`,
    }),
  ],
  [
    "kasir: POST order-issue-charges waive (only collect-at-pos is open)",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/waive`,
    }),
  ],
  [
    "kasir: POST order-issue-charges expire (only collect-at-pos is open)",
    () => ({
      method: "post",
      path: `/api/order-issue-charges/${randomUUID()}/expire`,
    }),
  ],
  [
    "default tolak: GET outlet delivery-orders (di luar semua grup)",
    () => ({ method: "get", path: `${outletBase()}/delivery-orders` }),
  ],
];

// /api/auth/* is not behind requireAuth; it has its own guard (section D.2).
const AUTH_OPEN: Entry[] = [
  [
    "auth: GET get-session",
    () => ({ method: "get", path: "/api/auth/get-session" }),
  ],
];

const AUTH_CLOSED: Entry[] = [
  [
    "auth: POST change-password",
    () => ({ method: "post", path: "/api/auth/change-password" }),
  ],
  [
    "auth: GET list-sessions",
    () => ({ method: "get", path: "/api/auth/list-sessions" }),
  ],
  [
    "auth: POST revoke-sessions",
    () => ({ method: "post", path: "/api/auth/revoke-sessions" }),
  ],
  [
    "auth: POST update-user",
    () => ({ method: "post", path: "/api/auth/update-user" }),
  ],
  [
    "auth: GET admin/list-users",
    () => ({ method: "get", path: "/api/auth/admin/list-users" }),
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

type Mode = {
  name: string;
  /** Session fixture prepared once per mode. */
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

  it.each(AUTH_OPEN)("%s is not closed", async (_name, build) => {
    expectNotClosed(await send(who, build(), mode.deviceFor()));
  });

  it.each(AUTH_CLOSED)(
    "%s answers 403 SHARED_DEVICE_SCREEN_CLOSED",
    async (_name, build) => {
      expectClosed(await send(who, build(), mode.deviceFor()));
    },
  );

  it("POST /api/auth/sign-out stays open and ends the session", async () => {
    const leaving = await mode.prepare();
    const response = await send(
      leaving,
      { method: "post", path: "/api/auth/sign-out" },
      mode.deviceFor(),
    );
    expectNotClosed(response);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("GET /api/me/access still answers 200 and says sharedDevice: true", async () => {
    const response = await send(
      who,
      { method: "get", path: "/api/me/access" },
      mode.deviceFor(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      (response.body as { data: { sharedDevice?: boolean } }).data.sharedDevice,
    ).toBe(true);
  });
});

// ---- personal devices and other edge cases ------------------------------------

describe("legend-iq0jz personal devices stay fully open", () => {
  it.each([...OPEN, ...CLOSED])(
    "%s: a clean session without a device header is never closed",
    async (_name, build) => {
      const who = await member("Pribadi Bersih");
      expect(await sessionMark(who.userId)).toEqual([]);
      expectNotClosed(await send(who, build(), null));
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

  it.each([...AUTH_OPEN, ...AUTH_CLOSED])(
    "%s: a clean session without a device header is never closed",
    async (_name, build) => {
      const who = await member("Pribadi Auth");
      expectNotClosed(await send(who, build(), null));
    },
  );

  it.each(AUTH_CLOSED)(
    "%s: the token of an unflagged device does not close it",
    async (_name, build) => {
      const who = await member("Pribadi Auth Perangkat");
      expectNotClosed(await send(who, build(), personalDevice));
    },
  );

  it("POST /api/auth/sign-out works for a clean session", async () => {
    const who = await member("Pribadi Keluar");
    const response = await send(
      who,
      { method: "post", path: "/api/auth/sign-out" },
      null,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("GET /api/me/access says sharedDevice: false for a clean session", async () => {
    const who = await member("Pribadi Akses");
    const response = await send(
      who,
      { method: "get", path: "/api/me/access" },
      null,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      (response.body as { data: { sharedDevice?: boolean } }).data.sharedDevice,
    ).toBe(false);
  });

  it("GET /api/me/access says sharedDevice: false with the token of an unflagged device", async () => {
    const who = await member("Pribadi Akses Perangkat");
    const response = await send(
      who,
      { method: "get", path: "/api/me/access" },
      personalDevice,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      (response.body as { data: { sharedDevice?: boolean } }).data.sharedDevice,
    ).toBe(false);
  });

  it("a garbage X-Device-Token from a clean session is treated as not shared and never throws", async () => {
    const who = await member("Token Rusak");
    const response = await who.client
      .get("/api/operations/checklist-templates")
      .set(host)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, "garbage.token.value");
    expectNotClosed(response);
  });
});

describe("legend-iq0jz the mark follows the device", () => {
  it("unflagging the device drops the mark: operations open again for the same cookie", async () => {
    const id = await newDevice(true);
    const who = await member("Tanda Gugur");
    await markSession(who, id);
    expectClosed(
      await send(
        who,
        { method: "get", path: "/api/operations/checklist-templates" },
        null,
      ),
    );

    await setFlag(id, false);
    expectNotClosed(
      await send(
        who,
        { method: "get", path: "/api/operations/checklist-templates" },
        null,
      ),
    );
    expectNotClosed(
      await send(who, { method: "get", path: "/api/auth/list-sessions" }, null),
    );
    const access = await send(
      who,
      { method: "get", path: "/api/me/access" },
      null,
    );
    expect(
      (access.body as { data: { sharedDevice?: boolean } }).data.sharedDevice,
    ).toBe(false);
  });

  it("revoking the device drops the mark and its token no longer closes operations", async () => {
    const id = await newDevice(true);
    const who = await member("Tanda Cabut");
    await markSession(who, id);
    await owner.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [id],
    );
    expectNotClosed(
      await send(
        who,
        { method: "get", path: "/api/operations/checklist-templates" },
        null,
      ),
    );
  });

  it("a marked session of tenant A calling operations of tenant B is refused with 403", async () => {
    const who = await member("Lintas Tenant");
    await markSession(who, sharedDevice);
    const response = await send(
      who,
      { method: "get", path: "/api/operations/checklist-templates" },
      null,
      hostB,
    );
    expectClosed(response);
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
    ["GET", `/api/outlets/${o}/reservation-policy`],
    ["GET", `/api/outlets/${o}/kitchen/stations`],
    ["POST", `/api/outlets/${o}/kitchen/tickets/${randomUUID()}/bump`],
    ["GET", `/api/outlets/${o}/floor`],
    ["POST", "/api/staff-pins/pos-session"],
    ["POST", `/api/order-issue-charges/${randomUUID()}/collect-at-pos`],
    ["POST", "/api/table-links"],
    ["POST", `/api/table-sessions/${randomUUID()}/close`],
    ["POST", "/api/ai/ask"],
    ["GET", "/api/ai/conversations"],
    ["GET", `/api/ai/conversations/${randomUUID()}`],
    ["GET", "/api/ai/usage"],
    ["GET", "/api/ai/tools"],
    ["GET", "/api/me/access"],
    ["GET", "/api/me/active-outlet"],
    // Normalisation: case and one trailing slash.
    ["GET", `/API/Outlets/${o}/POS/catalog`],
    ["GET", `/api/outlets/${o}/pos/catalog/`],
  ];

  const closed: [string, string][] = [
    ["GET", "/api/operations/checklist-templates"],
    ["POST", "/api/operations/checklist-runs"],
    ["GET", "/api/hris/announcements"],
    ["POST", "/api/facility/areas"],
    ["POST", "/api/wifi/sessions"],
    ["GET", "/api/wifi/policy"],
    ["GET", "/api/notifications"],
    ["GET", "/api/ai/governance"],
    ["GET", "/api/ai/provider"],
    ["GET", "/api/inventory/balances"],
    ["GET", `/api/outlets/${o}/delivery-orders`],
    // order-issue-charges: only POST collect-at-pos is open (no broad prefix).
    ["POST", `/api/order-issue-charges/${randomUUID()}/refund`],
    ["POST", `/api/order-issue-charges/${randomUUID()}/waive`],
    ["POST", `/api/order-issue-charges/${randomUUID()}/expire`],
    ["GET", `/api/order-issue-charges/${randomUUID()}/collect-at-pos`],
    ["GET", `/api/order-issue-charges/${randomUUID()}`],
    ["GET", "/"],
    ["GET", ""],
    // Whole-segment matching, anchored patterns.
    ["GET", `/api/outlets/${o}/posx`],
    ["GET", `/api/outlets/${o}/posx/catalog`],
    ["GET", `/api/outlets/${o}/pos-extra`],
    ["GET", "/api/ai/askx"],
    ["GET", "/api/ai/conversationsx"],
    ["GET", "/api/me/accessx"],
    ["GET", `/prefix/api/outlets/${o}/pos/catalog`],
    // Traversal, encoded separators, double slash, backslash.
    ["GET", `/api/outlets/${o}/pos/../operations`],
    ["GET", `/api/outlets/${o}/pos/%2e%2e/operations`],
    ["GET", `/api/outlets/${o}/pos/%2E%2E/operations`],
    ["GET", `/api/outlets/${o}/pos%2fcatalog`],
    ["GET", `/api/outlets/${o}/pos%2Fcatalog`],
    ["GET", `/api/outlets/${o}/pos%5Ccatalog`],
    ["GET", `/api/outlets/${o}//pos/catalog`],
    ["GET", `//api/outlets/${o}/pos/catalog`],
    ["GET", `/api/outlets/${o}/pos\\catalog`],
    // Shell is GET only.
    ["POST", "/api/me/access"],
    ["PUT", "/api/me/active-outlet"],
    ["PATCH", "/api/me/active-outlet"],
    ["DELETE", "/api/me/active-outlet"],
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

// ---- pure unit: isSharedDeviceAuthAllowed --------------------------------------

describe("legend-iq0jz isSharedDeviceAuthAllowed", () => {
  const load = async () => import("../lib/shared-device-allowlist.ts");

  const allowed: [string, string][] = [
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/two-factor/verify-totp"],
    ["POST", "/api/auth/two-factor/verify-backup-code"],
    // Normalisation: case and one trailing slash.
    ["GET", "/API/Auth/Get-Session"],
    ["GET", "/api/auth/get-session/"],
  ];

  const closed: [string, string][] = [
    ["POST", "/api/auth/change-password"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-session"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/revoke-other-sessions"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/delete-user"],
    ["POST", "/api/auth/two-factor/enable"],
    ["POST", "/api/auth/two-factor/disable"],
    ["POST", "/api/auth/two-factor/generate-backup-codes"],
    ["GET", "/api/auth/admin/list-users"],
    ["POST", "/api/auth/admin/set-role"],
    ["POST", "/api/auth/admin/impersonate-user"],
    ["GET", "/api/auth"],
    ["GET", "/"],
    ["GET", ""],
    // Whole-segment matching, anchored patterns.
    ["GET", "/api/auth/get-sessionx"],
    ["POST", "/api/auth/sign-outx"],
    ["POST", "/api/auth/sign-inx/email"],
    // two-factor/verify-* is a wildcard in the brief, so no "verify-totpx" case.
    ["POST", "/api/auth/two-factor/verify-totp/extra"],
    ["GET", "/prefix/api/auth/get-session"],
    // Traversal, encoded separators, double slash, backslash.
    ["GET", "/api/auth/sign-in/../list-sessions"],
    ["POST", "/api/auth/sign-in/%2e%2e/change-password"],
    ["POST", "/api/auth/sign-in/%2E%2E/change-password"],
    ["POST", "/api/auth/sign-in%2fchange-password"],
    ["POST", "/api/auth/sign-in%5Cchange-password"],
    ["GET", "//api/auth/get-session"],
    ["GET", "/api/auth//get-session"],
    ["GET", "/api/auth\\get-session"],
  ];

  it.each(allowed)("allows %s %s", async (method, path) => {
    const { isSharedDeviceAuthAllowed } = await load();
    expect(isSharedDeviceAuthAllowed(method, path)).toBe(true);
  });

  it.each(closed)("closes %s %s", async (method, path) => {
    const { isSharedDeviceAuthAllowed } = await load();
    expect(isSharedDeviceAuthAllowed(method, path)).toBe(false);
  });
});
