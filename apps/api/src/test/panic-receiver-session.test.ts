// Emergency receiver session on the outlet edge: device + staff PIN, no Better
// Auth (design docs/design/edge-emergency.md D-02, D-03, D-04, D-10, D-11;
// acceptance EM-02 .. EM-06, EM-13, EM-16, EM-17). Written BEFORE the
// implementation; fails until the receiver-session routes, the
// panic_receiver_sessions table and the realtime socket exist. Written from the
// design, never from code.
//
// Real stack: the Express app in edge mode, PostgreSQL with RLS, a real
// `ws` WebSocket on an http server, the real PIN hash/pepper/throttle. Staff
// are made with setStaffPin; duty is seeded as shift_assignments (segments with
// absolute startsAt/endsAt, the m1 shape) and attendance_logs rows.
//
// ASSUMPTIONS where the design is silent:
//  - POST /api/emergency/sessions with the dv1 device token header, a trusted
//    Origin and sessionBody(staffUserId, pin) (panic-test-helpers.ts) answers
//    200 or 201 and sets `legend_emergency`. Refusals: unregistered or wrong
//    type device 401; wrong PIN 401 PIN_INVALID; device throttle 429
//    PIN_DEVICE_THROTTLED (+ Retry-After 1..300); staff lock code PIN_LOCKED
//    (status not fixed, any 4xx); off duty 403 NOT_ON_DUTY; no permission 403
//    (any code but NOT_ON_DUTY).
//  - "Stored only as SHA-256": token_hash equals SHA-256 of the whole cookie
//    value or of its random part (the design says "the token"); both accepted.
//  - A revoked session answers 401 on ack. Another outlet's alert answers 403
//    or 404 on ack. A refused Origin answers 403; a refused WS upgrade answers
//    401 or 403 (never 101).
//  - Max 3 live sessions per staff: the 4th login may end the oldest or be
//    refused; only "at most 3 live rows" is asserted.
//  - Overnight duty: a shift whose business_date is yesterday but whose
//    segments still cover now (the segments hold absolute timestamps).
//  - Duty window end for a session = shift end + 30 min grace; the 14 h cap
//    counts from issue (shift) or from the clock-in (clock-in duty).
//  - An alert is made by a `panic_button` device (POST press); the alert row id
//    is read from panic_alerts by first_device_event_id; a frame mentions it as
//    uuid or as ULID.
//  - "Staff inactive" = employees.status "suspended"; "permission removed" =
//    role_assignments rows deleted; "PIN changed" = setStaffPin again.
//  - Revocation is re-checked at every send: the test presses a NEW alert on a
//    new button after the change and expects close code 4401 and no frame.
//  - The log capture app and the sockets run under EDGE_MODE=true
//    (withEdgeModeEnv), like edge-pin-proof.test.ts.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Must run before ../config/env is first imported (imports are hoisted).
vi.hoisted(() => {
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000011.5d1e7c00-0000-4000-8000-000000000012.5d1e7c00-0000-4000-8000-000000000013." +
    "A".repeat(43);
});

const upgradeBarrier = vi.hoisted(() => ({
  afterRead: null as null | (() => Promise<void>),
}));
vi.mock("../services/panic-receiver-session.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../services/panic-receiver-session.ts")
    >();
  return {
    ...original,
    authenticateReceiverSession: async (
      ...args: Parameters<typeof original.authenticateReceiverSession>
    ) => {
      const session = await original.authenticateReceiverSession(...args);
      if (session && upgradeBarrier.afterRead) await upgradeBarrier.afterRead();
      return session;
    },
  };
});

import { roleTemplate, type RoleTemplateKey } from "@starter/shared/access";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { guardEdgeUpgrades } from "../edge/mode.ts";
import { subscribe, type HubSubscriber } from "../edge/panic-relay-hub.ts";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { createLogger } from "../lib/logger.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { enrollDevice, revokeDevice } from "../services/device.service.ts";
import {
  findReceiverSessionAny,
  recheckReceiverSession,
  revokeReceiverSession,
} from "../services/panic-receiver-session.ts";
import {
  installEdgeNodeForTests,
  removeEdgeNodeForTests,
  withEdgeModeEnv,
} from "./edge-mode-env.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent, WEB_ORIGIN } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_ERR_NOT_ON_DUTY,
  PANIC_MAX_CLOCK_IN_DUTY_HOURS,
  PANIC_NON_RECEIVER_ROLES,
  PANIC_PERMISSION_RESOLVE,
  PANIC_PERMISSION_RESPOND,
  PANIC_REALTIME_ATTACH,
  PANIC_RECEIVER_ROLES,
  PANIC_RESOLVER_ROLES,
  PANIC_REVOKED_CLOSE_CODE,
  PANIC_ROUTES,
  PANIC_SHIFT_GRACE_MINUTES,
  PANIC_WS_PROTOCOL,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";
import {
  createOwnerPool,
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const PIN = "582914";
const WRONG = "907153";
const NEW_PIN = "316027";
const EVIL_ORIGIN = "https://evil.example";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WIB_OFFSET = 7 * HOUR;
const DEADLINE_MS = 10_000; // upper bound of a wait, never a delay

const edge = createApp({ edgeMode: true });
// A second edge app whose access log is captured (EM-13).
const logLines: Record<string, unknown>[] = [];
const edgeLogged = createApp({
  edgeMode: true,
  logger: createLogger({
    level: "debug",
    destination: new Writable({
      write(chunk, _encoding, done) {
        for (const line of String(chunk).split("\n").filter(Boolean))
          logLines.push(JSON.parse(line));
        done();
      },
    }),
  }),
});
// From here on the process is a cloud-style process unless wrapped.
delete process.env.EDGE_MODE;

// A tenant of its own (not the shared seeded one), created in beforeAll.
let tenant: IsolatedTenant;
let tenantContext: ReturnType<typeof establishTenantContext>;
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });
const actor = randomUUID();

const outletPeppers = new Map<string, Buffer>();
let outletA: string;
let outletB: string;
let adminUserId: string;
let tenantB: SecondTenant;
let ownerB: Pool;

// ---- fixtures ---------------------------------------------------------------------

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

/**
 * An edge holds the peppers of ONE outlet (the registry refuses a second). The
 * file plays one edge at a time: outlet A by default, and switches to outlet B
 * only around the PIN work of a B staff or of a B device.
 */
let edgeOutlet: string | null = null;
const tokenOutlet = new Map<string, string>();
function holdPeppers(outlet: string) {
  resetEdgeStaffPinPeppers();
  let pepper = outletPeppers.get(outlet);
  if (pepper === undefined) {
    pepper = randomBytes(32);
    outletPeppers.set(outlet, pepper);
  }
  installEdgeStaffPinPeppers(tenant.tenantId, outlet, [{ version: 2, pepper }]);
  edgeOutlet = outlet;
}
const ensurePeppers = (outlet: string) => {
  if (edgeOutlet !== outlet) holdPeppers(outlet);
};

async function seedOutlet(label: string) {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.tenantId,
        tenant.brandId,
        tenant.legalEntityId,
        `EM-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    );
  });
  return id;
}

async function enrollAt(
  outlet: string,
  type: "pos" | "waiter_phone" | "panic_button",
  label: string,
) {
  const enrolled = await enrollDevice(outletScope(outlet), actor, {
    outletId: outlet,
    type,
    label: `${label} ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  tokenOutlet.set(enrolled.token, outlet);
  return { token: enrolled.token, id: enrolled.device.id, outlet };
}
type Device = Awaited<ReturnType<typeof enrollAt>>;

const buttonsToRetire: Device[] = [];
/** A new panic button for each alert: a second press of one button folds (D-06). */
async function newButton(outlet: string) {
  const button = await enrollAt(outlet, "panic_button", "Tombol");
  buttonsToRetire.push(button);
  return button;
}

function forgedToken(deviceId: string, tenantId: string = tenant.tenantId) {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId,
    brandId: null,
    deviceId,
  });
}

async function grantRole(
  userId: string,
  permissions: string[],
  outlet: string,
) {
  const roleId = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, false, '["outlet"]')`,
      [
        roleId,
        tenant.tenantId,
        `Darurat ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.tenantId, userId, roleId, outlet],
    );
  });
}

async function insertUser(label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, label, `${id}@example.test`],
  );
  return id;
}

type StaffOptions = {
  outlet?: string;
  permissions?: string[];
  employeeStatus?: string;
};

/** Staff of an outlet with a 6-digit PIN and (by default) the emergency permission. */
async function newStaff(name: string, options: StaffOptions = {}) {
  const outlet = options.outlet ?? outletA;
  const userId = await insertUser(name);
  await grantRole(
    userId,
    options.permissions ?? [PANIC_PERMISSION_RESPOND],
    outlet,
  );
  const employeeId = randomUUID();
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Darurat', $5, 'pkwtt', '2025-03-01', $6)`,
      [
        employeeId,
        tenant.tenantId,
        userId,
        `EM-${employeeId.slice(0, 8).toUpperCase()}`,
        outlet,
        options.employeeStatus ?? "active",
      ],
    );
  });
  ensurePeppers(outlet);
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: outlet, userId },
    { pin: PIN },
  );
  return { userId, employeeId, outlet };
}
type Staff = Awaited<ReturnType<typeof newStaff>>;

const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

/** A published shift whose window is [now + startOffset, now + endOffset]. */
async function seedShift(
  staff: Staff,
  startOffsetMs: number,
  endOffsetMs: number,
  options: { outlet?: string; businessDate?: string } = {},
) {
  const id = randomUUID();
  const now = Date.now();
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        id,
        tenant.tenantId,
        options.outlet ?? staff.outlet,
        staff.employeeId,
        options.businessDate ?? wibDate(now + startOffsetMs),
        JSON.stringify([
          {
            startsAt: new Date(now + startOffsetMs).toISOString(),
            endsAt: new Date(now + endOffsetMs).toISOString(),
          },
        ]),
        adminUserId,
      ],
    ),
  );
  return id;
}

async function moveShift(
  shiftId: string,
  startOffsetMs: number,
  endOffsetMs: number,
) {
  const now = Date.now();
  await asTenant((client) =>
    client.query(
      "UPDATE shift_assignments SET segments = $3 WHERE tenant_id = $1 AND id = $2",
      [
        tenant.tenantId,
        shiftId,
        JSON.stringify([
          {
            startsAt: new Date(now + startOffsetMs).toISOString(),
            endsAt: new Date(now + endOffsetMs).toISOString(),
          },
        ]),
      ],
    ),
  );
}

/** A clock-in or clock-out of the staff `agoMs` ago, at the staff's outlet. */
async function seedClock(
  staff: Staff,
  type: "in" | "out",
  agoMs: number,
  outlet: string = staff.outlet,
) {
  const at = new Date(Date.now() - agoMs);
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, business_date, client_event_id)
       VALUES ($1, $2, $3, $4, $5, 'outlet_device', $6, $6, 'valid', $7, $8)`,
      [
        ulidToUuid(createUlid()),
        tenant.tenantId,
        outlet,
        staff.employeeId,
        type,
        at.toISOString(),
        wibDate(at.getTime()),
        createUlid(),
      ],
    ),
  );
  return at;
}

/** On duty by a shift that covers now. */
async function onDutyStaff(name: string, options: StaffOptions = {}) {
  const staff = await newStaff(name, options);
  const shiftId = await seedShift(staff, -HOUR, 7 * HOUR);
  return { ...staff, shiftId };
}

// ---- requests ---------------------------------------------------------------------

type SessionOptions = { origin?: string | null };

const openSession = (
  deviceToken: string,
  userId: string,
  pin: string,
  options: SessionOptions = {},
  app: Parameters<typeof agent>[0] = edge,
) =>
  withEdgeModeEnv(async () => {
    // The edge verifies with the peppers of the device's outlet.
    ensurePeppers(tokenOutlet.get(deviceToken) ?? outletA);
    // This edge process serves the device's outlet (one outlet per edge).
    installEdgeNodeForTests({
      tenantId: tenant.tenantId,
      outletId: tokenOutlet.get(deviceToken) ?? outletA,
    });
    let req = agent(app)
      .post(PANIC_ROUTES.sessions)
      .set(DEVICE_TOKEN_HEADER, deviceToken);
    if (options.origin !== null)
      req = req.set("Origin", options.origin ?? WEB_ORIGIN);
    return await req.send(sessionBody(userId, pin));
  });

const pressAlert = (button: Device, eventId: string, kind?: "press" | "test") =>
  withEdgeModeEnv(async () => {
    installEdgeNodeForTests({
      tenantId: tenant.tenantId,
      outletId: button.outlet,
    });
    return agent(edge)
      .post(PANIC_ROUTES.press)
      .set(DEVICE_TOKEN_HEADER, button.token)
      .send(pressBody(eventId, { kind }));
  });

/** Rings an alert and returns its id (uuid). */
async function ring(outlet: string) {
  const button = await newButton(outlet);
  const eventId = `em-${randomUUID()}`;
  const response = await pressAlert(button, eventId);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return { button, eventId, alertId: await alertIdOf(eventId) };
}

const ackAlert = (
  cookie: string | null,
  alertId: string,
  options: { origin?: string | null; app?: Parameters<typeof agent>[0] } = {},
) =>
  withEdgeModeEnv(async () => {
    let req = agent(options.app ?? edge).post(PANIC_ROUTES.ack(alertId));
    if (options.origin !== null)
      req = req.set("Origin", options.origin ?? WEB_ORIGIN);
    if (cookie !== null)
      req = req.set("Cookie", `${PANIC_COOKIE_NAME}=${cookie}`);
    return await req.send({});
  });

const logoutSession = (cookie: string) =>
  withEdgeModeEnv(async () =>
    agent(edge)
      .delete(PANIC_ROUTES.sessionCurrent)
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", `${PANIC_COOKIE_NAME}=${cookie}`),
  );

const codeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

type Cookie = { raw: string; value: string; random: string };

function cookieOf(response: {
  headers: Record<string, unknown>;
}): Cookie | null {
  const header = response.headers["set-cookie"];
  const list = Array.isArray(header) ? (header as string[]) : [];
  const raw = list.find((c) => c.startsWith(`${PANIC_COOKIE_NAME}=`));
  if (raw === undefined) return null;
  const value = raw.slice(PANIC_COOKIE_NAME.length + 1).split(";")[0]!;
  return { raw, value, random: value.split(".").slice(1).join(".") };
}

/** Opens a session and returns its cookie; the status check names the failure. */
async function loginOk(
  device: Device,
  staff: Staff,
  pin: string = PIN,
): Promise<Cookie> {
  const response = await openSession(device.token, staff.userId, pin);
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  const cookie = cookieOf(response);
  expect(cookie, "Set-Cookie legend_emergency missing").not.toBeNull();
  return cookie!;
}

// ---- database reads ---------------------------------------------------------------

type SessionRow = {
  id: string;
  device_id: string;
  revoked_at: Date | null;
  revoke_reason: string | null;
  issued_at: Date;
  expires_at: Date;
  token_hash_hex: string;
};

async function sessionRows(userId: string) {
  const { rows } = await owner.query<SessionRow>(
    `SELECT id::text, device_id::text, revoked_at, revoke_reason, issued_at, expires_at,
            encode(token_hash, 'hex') AS token_hash_hex
       FROM panic_receiver_sessions
      WHERE tenant_id = $1 AND user_id::text = $2 ORDER BY issued_at`,
    [tenant.tenantId, userId],
  );
  return rows;
}

const liveRows = async (userId: string) =>
  (await sessionRows(userId)).filter((r) => r.revoked_at === null);

async function alertIdOf(eventId: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id::text FROM panic_alerts WHERE tenant_id = $1 AND first_device_event_id = $2",
    [tenant.tenantId, eventId],
  );
  expect(rows, `no panic_alerts row for event ${eventId}`).toHaveLength(1);
  return rows[0]!.id;
}

async function ackedAt(alertId: string) {
  const { rows } = await owner.query<{ acknowledged_at: Date | null }>(
    "SELECT acknowledged_at FROM panic_alerts WHERE tenant_id = $1 AND id::text = $2",
    [tenant.tenantId, alertId],
  );
  return rows[0]?.acknowledged_at ?? null;
}

async function pinRow(userId: string) {
  const { rows } = await owner.query<{
    failed_attempts: number;
    locked_until: Date | null;
  }>(
    "SELECT failed_attempts, locked_until FROM staff_pins WHERE tenant_id = $1 AND user_id::text = $2",
    [tenant.tenantId, userId],
  );
  return rows[0];
}

async function proofRows(userId: string) {
  const { rows } = await owner.query(
    "SELECT 1 FROM staff_pin_proofs WHERE tenant_id = $1 AND user_id::text = $2",
    [tenant.tenantId, userId],
  );
  return rows.length;
}

async function attendanceRows(employeeId: string) {
  const { rows } = await owner.query(
    "SELECT 1 FROM attendance_logs WHERE tenant_id = $1 AND employee_id = $2",
    [tenant.tenantId, employeeId],
  );
  return rows.length;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// ---- real WebSocket ---------------------------------------------------------------

let http: Server | undefined;
let realtime: { close?: () => unknown } | undefined;
let httpPort = 0;
const sockets: WebSocket[] = [];

async function startSocketServer() {
  if (http) return httpPort;
  const mod = (await import(
    /* @vite-ignore */ PANIC_REALTIME_ATTACH.module
  ).catch((error: unknown) => {
    throw new Error(
      `Realtime module ${PANIC_REALTIME_ATTACH.module} is missing: ${String(error)}`,
    );
  })) as Record<string, unknown>;
  const attach = mod[PANIC_REALTIME_ATTACH.exportName];
  if (typeof attach !== "function")
    throw new Error(
      `${PANIC_REALTIME_ATTACH.module} does not export ${PANIC_REALTIME_ATTACH.exportName}`,
    );
  const server = createServer(edge);
  guardEdgeUpgrades(server, { edgeMode: true });
  realtime = attach(server, {
    trustedOrigins: [WEB_ORIGIN],
  }) as typeof realtime;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  http = server;
  httpPort = (server.address() as AddressInfo).port;
  return httpPort;
}

type Sock = {
  ws: WebSocket;
  frames: string[];
  closed: Promise<number>;
  closeCode: () => number | null;
};
type Connect = { ok: true; sock: Sock } | { ok: false; status: number };

async function connectSocket(
  cookie: string | null,
  options: { origin?: string | null; query?: string } = {},
): Promise<Connect> {
  const port = await startSocketServer();
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.Cookie = `${PANIC_COOKIE_NAME}=${cookie}`;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}${options.query ?? ""}`,
    PANIC_WS_PROTOCOL,
    {
      headers,
      ...(options.origin === null
        ? {}
        : { origin: options.origin ?? WEB_ORIGIN }),
    },
  );
  sockets.push(ws);
  const frames: string[] = [];
  let code: number | null = null;
  const closed = new Promise<number>((resolve) => {
    ws.on("close", (c) => {
      code = c;
      resolve(c);
    });
  });
  ws.on("message", (data) => frames.push(String(data)));
  return await new Promise<Connect>((resolve) => {
    ws.once("open", () =>
      resolve({
        ok: true,
        sock: { ws, frames, closed, closeCode: () => code },
      }),
    );
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ ok: false, status: res.statusCode ?? 0 });
    });
    ws.once("error", () => undefined);
  });
}

async function connectOk(cookie: Cookie) {
  const result = await withEdgeModeEnv(() => connectSocket(cookie.value));
  expect(result.ok, `socket refused: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.sock;
}

async function until(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = DEADLINE_MS,
) {
  const end = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const mentions = (frames: string[], alertId: string) =>
  frames.some(
    (frame) => frame.includes(alertId) || frame.includes(uuidToUlid(alertId)),
  );

/** Waits for the frame of `alertId`, with a bound that only prevents a hang. */
const gotAlert = (sock: Sock, alertId: string) =>
  until(() => mentions(sock.frames, alertId), `frame for alert ${alertId}`);

const expectClosed4401 = async (sock: Sock) => {
  await until(() => sock.closeCode() !== null, "socket close");
  expect(sock.closeCode()).toBe(PANIC_REVOKED_CLOSE_CODE);
};

/** Drops the file's own tenant and every row under it (append-only triggers off). */
async function purgeTenant() {
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`,
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenant.tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(
    `em-sess-${randomBytes(3).toString("hex")}`,
  );
  tenantContext = establishTenantContext({
    tenantId: tenant.tenantId,
    brandId: null,
    source: "session",
  });
  outletA = await seedOutlet("Outlet darurat A");
  outletB = await seedOutlet("Outlet darurat B");
  installEdgeNodeForTests({ tenantId: tenant.tenantId, outletId: outletA });
  holdPeppers(outletA);
  adminUserId = await insertUser("Admin Darurat");
  ownerB = createOwnerPool();
  tenantB = await createSecondTenant(ownerB, "em-darurat");
}, 90_000);

afterEach(async () => {
  installEdgeNodeForTests({ tenantId: tenant.tenantId, outletId: outletA });
  holdPeppers(outletA);
  // Free device quota: the retired buttons stay in the registry as revoked.
  for (const button of buttonsToRetire.splice(0))
    await revokeDevice(outletScope(button.outlet), actor, {
      deviceId: button.id,
      reason: "Uji darurat selesai",
    }).catch(() => undefined);
  for (const socket of sockets.splice(0)) socket.terminate();
});

afterAll(async () => {
  removeEdgeNodeForTests();
  for (const socket of sockets.splice(0)) socket.terminate();
  await realtime?.close?.();
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  resetEdgeStaffPinPeppers();
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await purgeTenant();
  if (ownerB && tenantB)
    await removeSecondTenant(ownerB, tenantB).catch(() => undefined);
  await ownerB?.end();
  await owner.end();
});

// ---- EM-02 duty (D-04) ------------------------------------------------------------

describe("EM-02 on duty (D-04): shift +-30 min or clock-in < 14 h", () => {
  it("EM-02 no shift and no clock-in -> 403 NOT_ON_DUTY and no session row", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Tanpa Tugas");
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
    expect(cookieOf(response)).toBeNull();
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });

  it("EM-02 shift ended 40 min ago -> NOT_ON_DUTY (grace is 30 min)", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Shift Lewat");
    await seedShift(
      staff,
      -9 * HOUR,
      -(PANIC_SHIFT_GRACE_MINUTES + 10) * MINUTE,
    );
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
  });

  it("EM-02 shift ended 20 min ago -> session issued (30 min grace after end)", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Shift Baru Usai");
    await seedShift(
      staff,
      -9 * HOUR,
      -(PANIC_SHIFT_GRACE_MINUTES - 10) * MINUTE,
    );
    await loginOk(device, staff);
  });

  it("EM-02 shift starts in 40 min -> NOT_ON_DUTY", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Shift Belum Mulai");
    await seedShift(staff, (PANIC_SHIFT_GRACE_MINUTES + 10) * MINUTE, 9 * HOUR);
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
  });

  it("EM-02 shift starts in 20 min -> session issued (30 min grace before start)", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Shift Hampir Mulai");
    await seedShift(staff, (PANIC_SHIFT_GRACE_MINUTES - 10) * MINUTE, 9 * HOUR);
    await loginOk(device, staff);
  });

  it("EM-02 overnight shift whose business date is yesterday still covers now", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Shift Malam");
    await seedShift(staff, -6 * HOUR, 2 * HOUR, {
      businessDate: wibDate(Date.now() - 24 * HOUR),
    });
    await loginOk(device, staff);
  });

  it("EM-02 a shift of ANOTHER outlet does not make the staff on duty here", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Shift Outlet Lain");
    await seedShift(staff, -HOUR, 7 * HOUR, { outlet: outletB });
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
  });

  it("EM-02 clock-in 13 h ago, no clock-out -> issued; the session ends 14 h after the clock-in", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Absen 13 Jam");
    const clockedIn = await seedClock(staff, "in", 13 * HOUR);
    await loginOk(device, staff);
    const [row] = await sessionRows(staff.userId);
    expect(row).toBeDefined();
    expect(row!.expires_at.getTime()).toBeLessThanOrEqual(
      clockedIn.getTime() + PANIC_MAX_CLOCK_IN_DUTY_HOURS * HOUR + MINUTE,
    );
    expect(row!.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("EM-02 clock-in 15 h ago, no clock-out -> NOT_ON_DUTY (14 h cap)", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Absen 15 Jam");
    await seedClock(staff, "in", 15 * HOUR);
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
  });

  it("EM-02 clock-in then clock-out and no shift -> NOT_ON_DUTY", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Sudah Pulang");
    await seedClock(staff, "in", 5 * HOUR);
    await seedClock(staff, "out", HOUR);
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
  });

  it("EM-02 clock-out during a still-active shift does not end duty (CTO decision)", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Pulang Cepat");
    await seedShift(staff, -4 * HOUR, 4 * HOUR);
    await seedClock(staff, "in", 4 * HOUR);
    await seedClock(staff, "out", HOUR);
    await loginOk(device, staff);
  });

  it("EM-02 clock-in at ANOTHER outlet does not count here", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Absen Outlet Lain");
    await seedClock(staff, "in", HOUR, outletB);
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).toBe(PANIC_ERR_NOT_ON_DUTY);
  });

  it("EM-02 session expires_at never passes the shift end + 30 min, nor 14 h from issue", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const shortShift = await newStaff("Staf Shift Pendek");
    await seedShift(shortShift, -HOUR, 2 * HOUR);
    await loginOk(device, shortShift);
    const [short] = await sessionRows(shortShift.userId);
    expect(short!.expires_at.getTime()).toBeLessThanOrEqual(
      Date.now() + 2 * HOUR + PANIC_SHIFT_GRACE_MINUTES * MINUTE + MINUTE,
    );
    expect(short!.expires_at.getTime()).toBeGreaterThan(Date.now());

    const device2 = await enrollAt(outletA, "pos", "Layar");
    const longShift = await newStaff("Staf Shift Panjang");
    await seedShift(longShift, -HOUR, 30 * HOUR);
    await loginOk(device2, longShift);
    const [long] = await sessionRows(longShift.userId);
    expect(long!.expires_at.getTime()).toBeLessThanOrEqual(
      long!.issued_at.getTime() + PANIC_MAX_CLOCK_IN_DUTY_HOURS * HOUR,
    );
  });

  it("EM-02 a live session stops receiving when the duty window ends: socket closed 4401, no frame", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Jendela Habis");
    const cookie = await loginOk(device, staff);
    const sock = await connectOk(cookie);
    // The window ends (past the grace): shift moved 2 h into the past.
    await moveShift(staff.shiftId, -10 * HOUR, -2 * HOUR);
    const { alertId } = await ring(outletA);
    await expectClosed4401(sock);
    expect(mentions(sock.frames, alertId)).toBe(false);
    const row = (await sessionRows(staff.userId))[0]!;
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoke_reason).toBe("off_duty");
  });
});

// ---- EM-03 permission (D-02) ------------------------------------------------------

describe("EM-03 permission facility.emergency.respond", () => {
  it("EM-03 on-duty staff WITHOUT the permission -> 403 (not NOT_ON_DUTY) and no session", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Kasir Tanpa Izin", {
      permissions: ["self.attendance.clock"],
    });
    await seedShift(staff, -HOUR, 7 * HOUR);
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(codeOf(response.body)).not.toBe(PANIC_ERR_NOT_ON_DUTY);
    expect(cookieOf(response)).toBeNull();
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });

  it("EM-03 permission granted only at ANOTHER outlet -> 403 here", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await newStaff("Staf Izin Outlet Lain", {
      permissions: ["self.attendance.clock"],
    });
    await grantRole(staff.userId, [PANIC_PERMISSION_RESPOND], outletB);
    await seedShift(staff, -HOUR, 7 * HOUR);
    const response = await openSession(device.token, staff.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });

  it("EM-03 control: the same staff WITH the permission gets a session", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Dengan Izin");
    await loginOk(device, staff);
    expect(await liveRows(staff.userId)).toHaveLength(1);
  });
});

// Founder answer Q95 (13 Nov, final): receivers are the on-duty facility
// attendant, supervisor, outlet manager and general manager; cashier and
// kitchen do not hold the permission and cannot open a session; only outlet
// manager and general manager close an incident (in the cloud). "kitchen" in
// PANIC_NON_RECEIVER_ROLES is not a template key: ASSUMPTION it means the two
// kitchen templates below.
const NON_RECEIVER_TEMPLATES: RoleTemplateKey[] = [
  "cashier",
  "kitchen_lead",
  "barista_cook",
];
const kitchenCovered = (PANIC_NON_RECEIVER_ROLES as readonly string[]).includes(
  "kitchen",
);

/** The tenant's own seeded template role (as the real role grant gives it). */
async function assignTemplateRole(
  userId: string,
  templateKey: RoleTemplateKey,
  outlet: string,
) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.tenantId, templateKey],
  );
  if (rows.length === 0) {
    // The isolated tenant has no seeded templates: create the one asked for,
    // from the same shared template the real role grant uses.
    const template = roleTemplate(templateKey);
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO roles
         (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, true, $3, $4::jsonb, $5, $6::jsonb)
       RETURNING id`,
      [
        tenant.tenantId,
        template.defaultName,
        templateKey,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
    rows.push(inserted.rows[0]!);
  }
  expect(rows, `no role template ${templateKey}`).toHaveLength(1);
  await asTenant((client) =>
    client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.tenantId, userId, rows[0]!.id, outlet],
    ),
  );
}

describe("EM-03 founder Q95: who holds the permission (role templates)", () => {
  it("EM-03 the shared role templates: respond for the four receiver roles only, resolve for outlet_manager + general_manager only", () => {
    expect(kitchenCovered).toBe(true);
    for (const key of PANIC_RECEIVER_ROLES)
      expect(
        roleTemplate(key).permissions,
        `${key} must hold ${PANIC_PERMISSION_RESPOND}`,
      ).toContain(PANIC_PERMISSION_RESPOND);
    for (const key of NON_RECEIVER_TEMPLATES)
      expect(
        roleTemplate(key).permissions,
        `${key} must not hold ${PANIC_PERMISSION_RESPOND}`,
      ).not.toContain(PANIC_PERMISSION_RESPOND);
    for (const key of PANIC_RECEIVER_ROLES)
      expect(
        (roleTemplate(key).permissions as readonly string[]).includes(
          PANIC_PERMISSION_RESOLVE,
        ),
        `${key} resolve`,
      ).toBe((PANIC_RESOLVER_ROLES as readonly string[]).includes(key));
    for (const key of NON_RECEIVER_TEMPLATES)
      expect(roleTemplate(key).permissions).not.toContain(
        PANIC_PERMISSION_RESOLVE,
      );
  });

  it.each([...PANIC_RECEIVER_ROLES])(
    "EM-03 on-duty %s (seeded role) opens a session",
    async (key) => {
      const device = await enrollAt(outletA, "pos", "Layar");
      const staff = await newStaff(`Staf ${key}`, { permissions: [] });
      await assignTemplateRole(staff.userId, key, outletA);
      await seedShift(staff, -HOUR, 7 * HOUR);
      await loginOk(device, staff);
    },
  );

  it.each(NON_RECEIVER_TEMPLATES)(
    "EM-03 on-duty %s (seeded role) is refused 403 and gets no session",
    async (key) => {
      const device = await enrollAt(outletA, "pos", "Layar");
      const staff = await newStaff(`Staf ${key}`, { permissions: [] });
      await assignTemplateRole(staff.userId, key, outletA);
      await seedShift(staff, -HOUR, 7 * HOUR);
      const response = await openSession(device.token, staff.userId, PIN);
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(codeOf(response.body)).not.toBe(PANIC_ERR_NOT_ON_DUTY);
      expect(cookieOf(response)).toBeNull();
      expect(await sessionRows(staff.userId)).toHaveLength(0);
    },
  );
});

// ---- EM-04 isolation (D-10) -------------------------------------------------------

describe("EM-04 tenant and outlet isolation", () => {
  it("EM-04 outlet B socket never sees outlet A alerts, outlet A socket does", async () => {
    const deviceA = await enrollAt(outletA, "pos", "Layar A");
    const deviceB = await enrollAt(outletB, "pos", "Layar B");
    const staffA = await onDutyStaff("Staf A", { outlet: outletA });
    const staffB = await onDutyStaff("Staf B", { outlet: outletB });
    const socketA = await connectOk(await loginOk(deviceA, staffA));
    const socketB = await connectOk(await loginOk(deviceB, staffB));

    const alertA = await ring(outletA);
    await gotAlert(socketA, alertA.alertId);
    // Outlet B's own alert arrives after A's: when it is here, A's would be.
    const alertB = await ring(outletB);
    await gotAlert(socketB, alertB.alertId);
    expect(mentions(socketB.frames, alertA.alertId)).toBe(false);
    expect(mentions(socketA.frames, alertB.alertId)).toBe(false);
  });

  it("EM-04 a device token of tenant B (real device id, tenant B prefix) -> 401 on sessions and press", async () => {
    const deviceA = await enrollAt(outletA, "pos", "Layar A");
    const button = await newButton(outletA);
    const staff = await onDutyStaff("Staf Tenant Lain");
    const crossSession = await openSession(
      forgedToken(deviceA.id, tenantB.tenantId),
      staff.userId,
      PIN,
    );
    expect(crossSession.status, JSON.stringify(crossSession.body)).toBe(401);
    expect(cookieOf(crossSession)).toBeNull();
    const crossPress = await pressAlert(
      { ...button, token: forgedToken(button.id, tenantB.tenantId) },
      `em-${randomUUID()}`,
    );
    expect(crossPress.status, JSON.stringify(crossPress.body)).toBe(401);
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });

  it("EM-04 staff of outlet B cannot open a session on a device of outlet A", async () => {
    const deviceA = await enrollAt(outletA, "pos", "Layar A");
    const staffB = await onDutyStaff("Staf B Tersasar", { outlet: outletB });
    const response = await openSession(deviceA.token, staffB.userId, PIN);
    expect([401, 403], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(cookieOf(response)).toBeNull();
    expect(await sessionRows(staffB.userId)).toHaveLength(0);
  });

  it("EM-04 a session of outlet A cannot acknowledge an alert of outlet B", async () => {
    const deviceA = await enrollAt(outletA, "pos", "Layar A");
    const staffA = await onDutyStaff("Staf A Ack", { outlet: outletA });
    const cookie = await loginOk(deviceA, staffA);
    const alertB = await ring(outletB);
    const response = await ackAlert(cookie.value, alertB.alertId);
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await ackedAt(alertB.alertId)).toBeNull();
  });
});

// ---- EM-05 PIN guesses (D-03 step 1-2) --------------------------------------------

describe("EM-05 unregistered device, device throttle, staff lock", () => {
  it("EM-05 unregistered device -> 401 BEFORE any PIN check: staff counters and throttle untouched", async () => {
    const staff = await onDutyStaff("Staf Sasaran Tebakan");
    const stranger = forgedToken(randomUUID());
    for (let i = 0; i < 12; i += 1) {
      const response = await openSession(stranger, staff.userId, WRONG);
      expect(response.status, JSON.stringify(response.body)).toBe(401);
      // Never the PIN verdict and never the throttle: the PIN was not checked.
      expect(codeOf(response.body)).not.toBe("PIN_INVALID");
      expect(codeOf(response.body)).not.toBe("PIN_DEVICE_THROTTLED");
    }
    const right = await openSession(stranger, staff.userId, PIN);
    expect(right.status, JSON.stringify(right.body)).toBe(401);
    expect(cookieOf(right)).toBeNull();
    expect(await pinRow(staff.userId)).toMatchObject({
      failed_attempts: 0,
      locked_until: null,
    });
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });

  it("EM-05 a missing device token -> 401 and no PIN check", async () => {
    const staff = await onDutyStaff("Staf Tanpa Token");
    const response = await withEdgeModeEnv(async () =>
      agent(edge)
        .post(PANIC_ROUTES.sessions)
        .set("Origin", WEB_ORIGIN)
        .send(sessionBody(staff.userId, WRONG)),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect((await pinRow(staff.userId))?.failed_attempts).toBe(0);
  });

  it("EM-05 a revoked device or a panic_button device cannot log staff in; no wrong PIN is counted", async () => {
    const staff = await onDutyStaff("Staf Perangkat Salah");
    const revoked = await enrollAt(outletA, "pos", "Layar dicabut");
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: revoked.id,
      reason: "Dicabut untuk uji",
    });
    const button = await newButton(outletA);
    for (const device of [revoked, button]) {
      const response = await openSession(device.token, staff.userId, WRONG);
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(codeOf(response.body)).not.toBe("PIN_INVALID");
      const right = await openSession(device.token, staff.userId, PIN);
      expect(right.status, JSON.stringify(right.body)).toBeGreaterThanOrEqual(
        400,
      );
      expect(cookieOf(right)).toBeNull();
    }
    expect((await pinRow(staff.userId))?.failed_attempts).toBe(0);
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });

  it("EM-05 10 wrong PINs from one device in 5 min -> the 11th is 429 PIN_DEVICE_THROTTLED with Retry-After, even for the right PIN", async () => {
    const flooded = await enrollAt(outletA, "pos", "Layar banjir");
    const calm = await enrollAt(outletA, "pos", "Layar tenang");
    const one = await onDutyStaff("Staf Banjir 1");
    const two = await onDutyStaff("Staf Banjir 2");
    const three = await onDutyStaff("Staf Banjir 3");
    const wrong = async (staff: Staff) => {
      const response = await openSession(flooded.token, staff.userId, WRONG);
      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expect(codeOf(response.body)).toBe("PIN_INVALID");
    };
    // 4 + 4 + 2 wrong PINs spread over three staff: nobody reaches the staff lock.
    for (let i = 0; i < 4; i += 1) await wrong(one);
    for (let i = 0; i < 4; i += 1) await wrong(two);
    for (let i = 0; i < 2; i += 1) await wrong(three);

    const blockedWrong = await openSession(flooded.token, three.userId, WRONG);
    expect(blockedWrong.status, JSON.stringify(blockedWrong.body)).toBe(429);
    expect(codeOf(blockedWrong.body)).toBe("PIN_DEVICE_THROTTLED");
    const retryAfter = Number(blockedWrong.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(300);

    const blockedRight = await openSession(flooded.token, one.userId, PIN);
    expect(blockedRight.status, JSON.stringify(blockedRight.body)).toBe(429);
    expect(cookieOf(blockedRight)).toBeNull();
    expect(await sessionRows(one.userId)).toHaveLength(0);

    // Another device is not throttled.
    const ok = await openSession(calm.token, one.userId, PIN);
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
  });

  it("EM-05 staff locked after 5 wrong PINs for 15 min: the right PIN is refused, on any device", async () => {
    const deviceOne = await enrollAt(outletA, "pos", "Layar kunci 1");
    const deviceTwo = await enrollAt(outletA, "pos", "Layar kunci 2");
    const staff = await onDutyStaff("Staf Terkunci");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await openSession(deviceOne.token, staff.userId, WRONG);
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(codeOf(response.body)).toBe(
        attempt < 5 ? "PIN_INVALID" : "PIN_LOCKED",
      );
    }
    const locked = await pinRow(staff.userId);
    expect(locked?.failed_attempts).toBe(5);
    expect(locked?.locked_until).not.toBeNull();
    const minutesLeft = (locked!.locked_until!.getTime() - Date.now()) / MINUTE;
    expect(minutesLeft).toBeGreaterThan(14);
    expect(minutesLeft).toBeLessThanOrEqual(15.5);

    for (const device of [deviceOne, deviceTwo]) {
      const response = await openSession(device.token, staff.userId, PIN);
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(codeOf(response.body)).toBe("PIN_LOCKED");
      expect(cookieOf(response)).toBeNull();
    }
    expect(await sessionRows(staff.userId)).toHaveLength(0);

    // The lock ends (moved into the past): the right PIN works again.
    await owner.query(
      "UPDATE staff_pins SET locked_until = now() - interval '1 second', failed_attempts = 0 WHERE tenant_id = $1 AND user_id::text = $2",
      [tenant.tenantId, staff.userId],
    );
    await loginOk(deviceTwo, staff);
  });

  it("EM-05 wrong PIN on a registered device -> 401 PIN_INVALID and no cookie", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Salah PIN");
    const response = await openSession(device.token, staff.userId, WRONG);
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(codeOf(response.body)).toBe("PIN_INVALID");
    expect(cookieOf(response)).toBeNull();
    expect(await sessionRows(staff.userId)).toHaveLength(0);
  });
});

// ---- EM-06 revocation (D-03 table) ------------------------------------------------

describe("EM-06 revocation: session revoked, socket closed 4401, nothing delivered", () => {
  type Change = {
    name: string;
    reason: string;
    apply: (staff: Staff, device: Device) => Promise<void>;
  };
  const changes: Change[] = [
    {
      name: "newer PIN generation (PIN changed)",
      reason: "pin_changed",
      apply: async (staff) => {
        ensurePeppers(staff.outlet);
        await setStaffPin(
          tenantContext,
          staff.userId,
          { outletId: staff.outlet, userId: staff.userId },
          { pin: NEW_PIN },
        );
      },
    },
    {
      name: "staff inactive",
      reason: "staff_inactive",
      apply: async (staff) => {
        await asTenant((client) =>
          client.query(
            "UPDATE employees SET status = 'suspended' WHERE tenant_id = $1 AND id = $2",
            [tenant.tenantId, staff.employeeId],
          ),
        );
      },
    },
    {
      name: "permission removed",
      reason: "permission_removed",
      apply: async (staff) => {
        await asTenant((client) =>
          client.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id::text = $2",
            [tenant.tenantId, staff.userId],
          ),
        );
      },
    },
    {
      name: "device revoked",
      reason: "device_revoked",
      apply: async (_staff, device) => {
        await revokeDevice(outletScope(device.outlet), actor, {
          deviceId: device.id,
          reason: "Dicabut untuk uji",
        });
      },
    },
  ];

  it.each(changes)(
    "EM-06 $name -> session revoked ($reason), socket closed 4401, the new alert is not delivered, ack refused",
    async ({ reason, apply }) => {
      const device = await enrollAt(outletA, "pos", "Layar");
      const staff = await onDutyStaff(`Staf Cabut ${reason}`);
      const cookie = await loginOk(device, staff);
      const sock = await connectOk(cookie);

      await apply(staff, device);
      // The edge re-checks at every send: a fresh alert triggers the check.
      const { alertId } = await ring(outletA);
      await expectClosed4401(sock);
      expect(mentions(sock.frames, alertId)).toBe(false);

      const rows = await sessionRows(staff.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revoked_at).not.toBeNull();
      expect(rows[0]!.revoke_reason).toBe(reason);

      const ack = await ackAlert(cookie.value, alertId);
      expect(ack.status, JSON.stringify(ack.body)).toBe(401);
      expect(await ackedAt(alertId)).toBeNull();
      const reconnect = await withEdgeModeEnv(() =>
        connectSocket(cookie.value),
      );
      expect(reconnect.ok).toBe(false);
    },
  );

  it("EM-06 control: an unchanged session receives the new alert and acknowledges it", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Kontrol Sesi");
    const cookie = await loginOk(device, staff);
    const sock = await connectOk(cookie);
    const { alertId } = await ring(outletA);
    await gotAlert(sock, alertId);
    expect(sock.closeCode()).toBeNull();
    const ack = await ackAlert(cookie.value, alertId);
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect(await ackedAt(alertId)).not.toBeNull();
  });
});

// ---- D-03 session cookie details ---------------------------------------------------

describe("D-03 receiver session cookie and lifetime", () => {
  it("D-03 cookie is `<tenantId>.<base64url 32 B>`, HttpOnly, SameSite=Strict, path /api/emergency; stored only as SHA-256", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Kuki");
    const response = await openSession(device.token, staff.userId, PIN);
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const cookie = cookieOf(response);
    expect(cookie).not.toBeNull();
    expect(cookie!.value.startsWith(`${tenant.tenantId}.`)).toBe(true);
    expect(cookie!.random).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(Buffer.from(cookie!.random, "base64url")).toHaveLength(32);
    expect(cookie!.raw).toMatch(/;\s*HttpOnly/i);
    expect(cookie!.raw).toMatch(/;\s*SameSite=Strict/i);
    expect(cookie!.raw).toMatch(/;\s*Path=\/api\/emergency(;|$)/i);

    const [row] = await sessionRows(staff.userId);
    expect([
      sha256(cookie!.value),
      createHash("sha256")
        .update(Buffer.from(cookie!.random, "base64url"))
        .digest("hex"),
      sha256(cookie!.random),
    ]).toContain(row!.token_hash_hex);
    const dump = await owner.query(
      "SELECT row_to_json(s)::text AS j FROM panic_receiver_sessions s WHERE tenant_id = $1 AND user_id::text = $2",
      [tenant.tenantId, staff.userId],
    );
    expect(dump.rows[0]!.j).not.toContain(cookie!.random);
  });

  it("D-03 the session response body never carries the token (cookie only)", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Badan Jawaban");
    const response = await openSession(device.token, staff.userId, PIN);
    const cookie = cookieOf(response);
    expect(cookie).not.toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(cookie!.random);
  });

  it("D-03 one live session per device: a new login on the device replaces the old one", async () => {
    const device = await enrollAt(outletA, "pos", "Layar bersama");
    const first = await onDutyStaff("Staf Pertama");
    const second = await onDutyStaff("Staf Kedua");
    const firstCookie = await loginOk(device, first);
    const sockFirst = await connectOk(firstCookie);
    await loginOk(device, second);

    const firstRows = await sessionRows(first.userId);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]!.revoked_at).not.toBeNull();
    expect(firstRows[0]!.revoke_reason).toBe("replaced");
    const live = await owner.query(
      "SELECT 1 FROM panic_receiver_sessions WHERE tenant_id = $1 AND device_id::text = $2 AND revoked_at IS NULL",
      [tenant.tenantId, device.id],
    );
    expect(live.rows).toHaveLength(1);
    await expectClosed4401(sockFirst);
    const ack = await ackAlert(
      firstCookie.value,
      (await ring(outletA)).alertId,
    );
    expect(ack.status, JSON.stringify(ack.body)).toBe(401);
  });

  it("D-03 at most 3 live sessions per staff", async () => {
    const staff = await onDutyStaff("Staf Banyak Layar");
    for (let i = 0; i < 4; i += 1) {
      const device = await enrollAt(outletA, "pos", `Layar banyak ${i}`);
      const response = await openSession(device.token, staff.userId, PIN);
      // Either the oldest ends or the 4th login is refused: ASSUMPTION above.
      if (i < 3)
        expect([200, 201], JSON.stringify(response.body)).toContain(
          response.status,
        );
    }
    const live = await liveRows(staff.userId);
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live.length).toBeLessThanOrEqual(3);
    expect((await sessionRows(staff.userId)).length).toBeGreaterThanOrEqual(3);
  });

  it("D-03 logging out on the device ends the session at once; the socket closes 4401", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Keluar");
    const cookie = await loginOk(device, staff);
    const sock = await connectOk(cookie);
    const response = await logoutSession(cookie.value);
    expect([200, 204], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const [row] = await sessionRows(staff.userId);
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.revoke_reason).toBe("logout");
    await expectClosed4401(sock);
    const ack = await ackAlert(cookie.value, (await ring(outletA)).alertId);
    expect(ack.status, JSON.stringify(ack.body)).toBe(401);
  });

  it("D-03 scope: the emergency cookie opens no other part of the API and is no Better Auth session", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Lingkup");
    const cookie = await loginOk(device, staff);
    const session = await withEdgeModeEnv(async () =>
      agent(edge)
        .get("/api/auth/get-session")
        .set("Cookie", `${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    expect(session.body?.user ?? null).toBeNull();
    const logs = await withEdgeModeEnv(async () =>
      agent(edge)
        .get("/api/hris/attendance/logs")
        .set("Cookie", `${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    expect([401, 403, 404]).toContain(logs.status);
  });

  it("D-03 the cookie of a tenant prefix that does not match the session is useless", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Prefiks");
    const cookie = await loginOk(device, staff);
    const forged = `${tenantB.tenantId}.${cookie.random}`;
    const ack = await ackAlert(forged, (await ring(outletA)).alertId);
    expect(ack.status, JSON.stringify(ack.body)).toBe(401);
  });
});

// ---- EM-13 token never in a URL, logs redact the cookie ---------------------------

describe("EM-13 the token stays out of URLs and logs", () => {
  it("EM-13 the socket takes the token from the cookie only: a token in the query string is refused", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf URL");
    const cookie = await loginOk(device, staff);
    for (const query of [
      `?${PANIC_COOKIE_NAME}=${encodeURIComponent(cookie.value)}`,
      `?token=${encodeURIComponent(cookie.value)}`,
      `?access_token=${encodeURIComponent(cookie.value)}`,
    ]) {
      const result = await withEdgeModeEnv(() =>
        connectSocket(null, { query }),
      );
      expect(result.ok, `query ${query.split("=")[0]} was accepted`).toBe(
        false,
      );
      if (!result.ok) expect([401, 403]).toContain(result.status);
    }
    // Control: the same token as a cookie on a clean URL opens the socket.
    const sock = await connectOk(cookie);
    expect(sock.closeCode()).toBeNull();
  });

  it("EM-13 the access log never holds the cookie or its random part (login, ack, refused ack, logout)", async () => {
    logLines.length = 0;
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Log");
    const response = await openSession(
      device.token,
      staff.userId,
      PIN,
      {},
      edgeLogged,
    );
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const cookie = cookieOf(response)!;
    expect(cookie).not.toBeNull();
    const { alertId } = await ring(outletA);
    await ackAlert(cookie.value, alertId, { app: edgeLogged });
    await ackAlert(cookie.value, alertId, {
      app: edgeLogged,
      origin: EVIL_ORIGIN,
    });
    await withEdgeModeEnv(async () =>
      agent(edgeLogged)
        .delete(PANIC_ROUTES.sessionCurrent)
        .set("Origin", WEB_ORIGIN)
        .set("Cookie", `${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    await until(() => logLines.length > 0, "access log lines");
    const output = JSON.stringify(logLines);
    expect(output).toContain(PANIC_ROUTES.sessions); // requests were logged
    expect(output).not.toContain(cookie.random);
    expect(output).not.toContain(cookie.value);
    expect(output).not.toContain(PIN);
  });
});

// ---- EM-16 no PIN proof, no attendance --------------------------------------------

describe("EM-16 an emergency login is not a PIN proof", () => {
  it("EM-16 leaves no staff_pin_proofs row and does not end another staff's live attendance proof on the device", async () => {
    const device = await enrollAt(outletA, "pos", "Layar bersama");
    const clocker = await newStaff("Staf Absen Biasa", {
      permissions: ["self.attendance.clock"],
    });
    const proofResponse = await agent(createApp({ edgeMode: false }))
      .post("/api/staff-pins/verify")
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ userId: clocker.userId, pin: PIN, purpose: "attendance_clock" });
    expect(proofResponse.status, JSON.stringify(proofResponse.body)).toBe(200);
    const before = await owner.query(
      "SELECT id::text, expires_at, consumed_at FROM staff_pin_proofs WHERE tenant_id = $1 AND user_id::text = $2",
      [tenant.tenantId, clocker.userId],
    );
    expect(before.rows).toHaveLength(1);

    const responder = await onDutyStaff("Staf Penerima");
    await loginOk(device, responder);

    expect(await proofRows(responder.userId)).toBe(0);
    const after = await owner.query(
      "SELECT id::text, expires_at, consumed_at FROM staff_pin_proofs WHERE tenant_id = $1 AND user_id::text = $2",
      [tenant.tenantId, clocker.userId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]!.consumed_at).toBeNull();
    expect(after.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("EM-16 the emergency cookie (alone, or as a proof header) cannot clock attendance", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Tak Bisa Absen");
    const cookie = await loginOk(device, staff);
    // Fixture only (assertions unchanged): the outlet needs an edge roster copy,
    // else outlet-clock answers 403 at the device check before it looks at the
    // proof header, and the test would not reach the proof path it names.
    await owner.query(
      `INSERT INTO edge_people_sync_state (tenant_id, outlet_id, last_checked_at)
       VALUES ($1, $2, now())
       ON CONFLICT (tenant_id, outlet_id) DO UPDATE SET last_checked_at = now()`,
      [tenant.tenantId, outletA],
    );
    const body = {
      type: "in",
      occurredAt: new Date().toISOString(),
      photoUploadRef: null,
      idempotencyKey: `em-clock-${randomUUID()}`,
    };
    const attempts = [
      { Cookie: `${PANIC_COOKIE_NAME}=${cookie.value}` },
      { "X-Pin-Proof": cookie.value },
      { "X-Pin-Proof": cookie.random },
    ];
    for (const headers of attempts) {
      const response = await withEdgeModeEnv(async () =>
        agent(edge)
          .post("/api/hris/attendance/outlet-clock")
          .set("Origin", WEB_ORIGIN)
          .set(DEVICE_TOKEN_HEADER, device.token)
          .set(headers)
          .send(body),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(401);
    }
    await owner.query(
      "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.tenantId, outletA],
    );
    expect(await attendanceRows(staff.employeeId)).toBe(0);
    expect(await proofRows(staff.userId)).toBe(0);
  });
});

// ---- EM-17 Origin ------------------------------------------------------------------

describe("EM-17 Origin checks on the socket and on the writes", () => {
  it("EM-17 a WebSocket upgrade from another Origin is refused; the trusted Origin opens", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Asal");
    const cookie = await loginOk(device, staff);
    const evil = await withEdgeModeEnv(() =>
      connectSocket(cookie.value, { origin: EVIL_ORIGIN }),
    );
    expect(evil.ok, "upgrade from another Origin was accepted").toBe(false);
    if (!evil.ok) expect([401, 403]).toContain(evil.status);
    const good = await withEdgeModeEnv(() =>
      connectSocket(cookie.value, { origin: WEB_ORIGIN }),
    );
    expect(good.ok).toBe(true);
  });

  it("EM-17 acknowledge without a trusted Origin is refused and acknowledges nothing", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Ack Asal");
    const cookie = await loginOk(device, staff);
    const { alertId } = await ring(outletA);
    const evil = await ackAlert(cookie.value, alertId, { origin: EVIL_ORIGIN });
    expect(evil.status, JSON.stringify(evil.body)).toBe(403);
    expect(await ackedAt(alertId)).toBeNull();
    const good = await ackAlert(cookie.value, alertId);
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(await ackedAt(alertId)).not.toBeNull();
  });

  it("EM-17 opening and ending a session from another Origin is refused", async () => {
    const device = await enrollAt(outletA, "pos", "Layar");
    const staff = await onDutyStaff("Staf Sesi Asal");
    const evil = await openSession(device.token, staff.userId, PIN, {
      origin: EVIL_ORIGIN,
    });
    expect(evil.status, JSON.stringify(evil.body)).toBe(403);
    expect(cookieOf(evil)).toBeNull();
    expect(await sessionRows(staff.userId)).toHaveLength(0);

    const cookie = await loginOk(device, staff);
    const logout = await withEdgeModeEnv(async () =>
      agent(edge)
        .delete(PANIC_ROUTES.sessionCurrent)
        .set("Origin", EVIL_ORIGIN)
        .set("Cookie", `${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    expect(logout.status, JSON.stringify(logout.body)).toBe(403);
    expect(await liveRows(staff.userId)).toHaveLength(1);
  });
});

describe("legend-aagpf stored revocation wins over a cached receiver session", () => {
  it("rejects the cached session after logout and preserves its stored reason", async () => {
    const device = await enrollAt(outletA, "waiter_phone", "Cached logout");
    const staff = await onDutyStaff("Cached logout receiver");
    const cookie = await loginOk(device, staff);
    const cached = await withEdgeModeEnv(() =>
      findReceiverSessionAny(`${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    expect(cached).not.toBeNull();
    expect(
      await withEdgeModeEnv(() => recheckReceiverSession(cached!)),
    ).toEqual({ ok: true });
    await revokeReceiverSession(cached!, "logout");
    expect(
      await withEdgeModeEnv(() => recheckReceiverSession(cached!)),
    ).toEqual({ ok: false, reason: "logout" });
    expect((await sessionRows(staff.userId))[0]?.revoke_reason).toBe("logout");
  });
});

describe("legend-aagpf revocation between upgrade lookup and subscription", () => {
  it("closes 4401 and discloses no alert location or responder name after the race", async () => {
    const device = await enrollAt(outletA, "waiter_phone", "Upgrade race");
    const staff = await onDutyStaff("Upgrade race receiver");
    const cookie = await loginOk(device, staff);
    const cached = await withEdgeModeEnv(() =>
      findReceiverSessionAny(`${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    expect(cached).not.toBeNull();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upgradeBarrier.afterRead = async () => {
      entered();
      await gate;
    };
    let connection: Promise<Connect>;
    try {
      connection = withEdgeModeEnv(() => connectSocket(cookie.value));
      await waiting;
      await revokeReceiverSession(cached!, "logout");
    } finally {
      upgradeBarrier.afterRead = null;
      release();
    }
    const connected = await connection;
    expect(connected.ok).toBe(true);
    if (!connected.ok)
      throw new Error("Expected upgrade to finish with its cached lookup");
    const { alertId } = await ring(outletA);
    const activeDevice = await enrollAt(
      outletA,
      "waiter_phone",
      "Active responder",
    );
    const activeStaff = await onDutyStaff("Private responder race name");
    const activeCookie = await loginOk(activeDevice, activeStaff);
    expect((await ackAlert(activeCookie.value, alertId)).status).toBe(200);
    await expectClosed4401(connected.sock);
    expect(mentions(connected.sock.frames, alertId)).toBe(false);
    expect(connected.sock.frames.join(" ")).not.toContain(
      "Private responder race name",
    );
  });
});

describe("legend-aagpf acknowledgement after a missed revocation broadcast", () => {
  it("rechecks stored logout before disclosing a responders name to a stale subscriber", async () => {
    const device = await enrollAt(
      outletA,
      "waiter_phone",
      "Stale ACK receiver",
    );
    const staff = await onDutyStaff("Stale ACK receiver");
    const cookie = await loginOk(device, staff);
    const cached = await withEdgeModeEnv(() =>
      findReceiverSessionAny(`${PANIC_COOKIE_NAME}=${cookie.value}`),
    );
    expect(cached).not.toBeNull();
    const { alertId } = await ring(outletA);
    const activeDevice = await enrollAt(outletA, "waiter_phone", "ACK control");
    const activeStaff = await onDutyStaff("Responder private ACK name");
    const activeCookie = await loginOk(activeDevice, activeStaff);
    await revokeReceiverSession(cached!, "logout");
    const frames: unknown[] = [];
    const closed: number[] = [];
    const stale: HubSubscriber = {
      session: cached!,
      alerts: new Map(),
      send: (frame) => {
        frames.push(frame);
        return true;
      },
      close: (code) => {
        closed.push(code);
      },
    };
    const unsubscribe = subscribe(stale);
    try {
      expect((await ackAlert(activeCookie.value, alertId)).status).toBe(200);
      await vi.waitFor(() =>
        expect(closed).toContain(PANIC_REVOKED_CLOSE_CODE),
      );
      expect(frames).toHaveLength(0);
      expect(JSON.stringify(frames)).not.toContain(
        "Responder private ACK name",
      );
    } finally {
      unsubscribe();
    }
  });
});
