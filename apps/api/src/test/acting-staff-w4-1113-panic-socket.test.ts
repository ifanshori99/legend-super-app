// legend-iq0jz / 1113 (second opinion P2): a panic receiver socket that was
// opened on a personal POS must close when that device becomes a shared tablet
// (founder Q29: shared tablets never open the panic stream). The shared-device
// check used to run only at upgrade time; the session recheck ignored the flag.
//
// Rule under test:
//  - `recheckReceiverSession` fails (device_revoked) for a shared device, so the
//    recheck timer and the check before every send/resend close the socket.
//  - `setDeviceSharedMode(true)` ends the receiver sessions of the device at
//    once (socket closes with 4401).
//  - Controls: a personal device keeps receiving, a new upgrade of a shared
//    device is refused (403), normal logout still closes with 4401.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createUlid, outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { guardEdgeUpgrades } from "../edge/mode.ts";
import { attachEmergencyRealtime } from "../edge/panic-relay-realtime.ts";
import {
  getEdgeRuntimeState,
  setDeviceRegistryReadyForTests,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  enrollDevice,
  setDeviceSharedMode,
} from "../services/device.service.ts";
import {
  authenticateReceiverSession,
  recheckReceiverSession,
} from "../services/panic-receiver-session.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_FRAME_ALERT,
  PANIC_FRAME_RECEIVED,
  PANIC_PERMISSION_RESPOND,
  PANIC_REVOKED_CLOSE_CODE,
  PANIC_ROUTES,
  PANIC_WS_PROTOCOL,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";

const PIN = "582914";
const SLOW_MS = 60_000;
const WAIT_MS = 15_000;
const QUIET_MS = 1_500;
const tenant = cafeLegendPlatformFixtures.tenant;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const edgeApp = createApp({ edgeMode: true });
const cloudApp = createApp({ edgeMode: false });
const cloudState = getEdgeRuntimeState();
const tenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });
const actor = randomUUID();

const deviceIds: string[] = [];
const employeeIds: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function asTenantOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

// ---- edge process + outlet world -------------------------------------------

const outletPeppers = new Map<string, Buffer>();
async function world(label: string) {
  const outlet = randomUUID();
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        outlet,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `SK-${outlet.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    ),
  );
  const pepper = randomBytes(32);
  outletPeppers.set(outlet, pepper);
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.id, outlet, [{ version: 2, pepper }]);
  setDeviceRegistryReadyForTests({});
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: outletScope(outlet),
      scope: {
        tenantId: tenant.id,
        outletId: outletIdSchema.parse(outlet),
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
  return outlet;
}

async function registerPanicButton(outlet: string) {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', 'Tombol Kamar', $4)`,
      [deviceId, tenant.id, outlet, new Date(issuedAt * 1000)],
    ),
  );
  deviceIds.push(deviceId);
  const token = signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: tenant.id,
    brandId: null,
    deviceId,
  });
  return { deviceId, token };
}

async function enrollPos(outlet: string) {
  const enrolled = await enrollDevice(outletScope(outlet), actor, {
    outletId: outlet,
    type: "pos",
    label: `Receiver ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  deviceIds.push(enrolled.device.id);
  return { token: enrolled.token, deviceId: enrolled.device.id };
}

const jakartaDateOf = (instantMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(instantMs),
  );

async function newStaff(label: string, outlet: string) {
  const client = agent(cloudApp);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await asTenantOwner(async (c) => {
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, false, '["outlet"]')`,
      [
        roleId,
        tenant.id,
        `Darurat ${roleId.slice(0, 8)}`,
        JSON.stringify([PANIC_PERMISSION_RESPOND]),
      ],
    );
    await c.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, outlet],
    );
    const employeeId = randomUUID();
    employeeIds.push(employeeId);
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `SK-${employeeId.slice(0, 8).toUpperCase()}`,
        label,
        outlet,
      ],
    );
    await c.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'outlet_device', now() - interval '3 hours',
               now() - interval '3 hours', 'valid', '[]', $5, $6, 'none')`,
      [
        ulidToUuid(createUlid()),
        tenant.id,
        outlet,
        employeeId,
        jakartaDateOf(Date.now() - 3 * 3_600_000),
        createUlid(),
      ],
    );
  });
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: outlet, userId },
    { pin: PIN },
  );
  return userId;
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw)
    ? (raw as string[])
    : raw
      ? [String(raw)]
      : [];
  const entry = list.find((c) => c.startsWith(`${PANIC_COOKIE_NAME}=`));
  expect(entry, `Set-Cookie ${PANIC_COOKIE_NAME} missing`).toBeDefined();
  return (entry as string).split(";")[0];
}

/** A receiver on a personal POS: device, live session cookie. */
async function receiver(outlet: string, label: string) {
  const userId = await newStaff(label, outlet);
  const device = await enrollPos(outlet);
  const res = await withEdgeModeEnv(() =>
    request(edgeApp)
      .post(PANIC_ROUTES.sessions)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send(sessionBody(userId, PIN)),
  );
  expect(
    [200, 201],
    `session issue answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  return { device, cookie: cookieOf(res) };
}

const press = (token: string) =>
  request(edgeApp)
    .post(PANIC_ROUTES.press)
    .set(DEVICE_TOKEN_HEADER, token)
    .send(pressBody(`evt-${randomUUID()}`));

async function raise(button: { token: string }) {
  const res = await press(button.token);
  expect(
    [200, 201],
    `press answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
}

const setSharedBySql = (deviceId: string) =>
  owner.query(
    "UPDATE devices SET shared_mode = true WHERE tenant_id = $1 AND id = $2",
    [tenant.id, deviceId],
  );

// ---- real WebSocket --------------------------------------------------------

let wsServer: { server: Server; port: number } | null = null;

async function startRealtime() {
  if (wsServer) return wsServer;
  const server = createServer(edgeApp);
  guardEdgeUpgrades(server, { edgeMode: true });
  const realtime = attachEmergencyRealtime(server, {
    trustedOrigins: [WEB_ORIGIN],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wsServer = { server, port: (server.address() as AddressInfo).port };
  cleanups.push(async () => {
    await realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wsServer = null;
  });
  return wsServer;
}

async function connect(cookie: string) {
  const { port } = await startRealtime();
  const frames: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}`,
    PANIC_WS_PROTOCOL,
    { headers: { Cookie: cookie, Origin: WEB_ORIGIN } },
  );
  let closedWith: number | null = null;
  ws.on("close", (code) => {
    closedWith = code;
  });
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    frames.push(frame);
    if (frame.type === PANIC_FRAME_ALERT && ws.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify({ type: PANIC_FRAME_RECEIVED, alertId: frame.alertId }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`socket upgrade refused with ${res.statusCode}`)),
    );
    ws.once("error", (error) => reject(error));
  });
  cleanups.push(() => ws.terminate());
  const waitFor = async (done: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !done())
      await new Promise((resolve) => setTimeout(resolve, 50));
    return done();
  };
  return {
    frames,
    closedWith: () => closedWith,
    alertFrames: () => frames.filter((f) => f.type === PANIC_FRAME_ALERT),
    waitFor,
  };
}

/** Status of a socket upgrade that is expected to be refused. */
async function upgradeStatus(cookie: string): Promise<number> {
  const { port } = await startRealtime();
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}`,
      PANIC_WS_PROTOCOL,
      { headers: { Cookie: cookie, Origin: WEB_ORIGIN } },
    );
    ws.once("open", () => {
      ws.terminate();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("error", (error) => reject(error));
  });
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setDeviceOutletResolver(createDeviceOutletResolver());
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  setEdgeRuntimeStateForTests(cloudState);
  setDeviceRegistryReadyForTests(null);
});

afterAll(async () => {
  try {
    await owner.query(
      "DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, deviceIds],
    );
    await owner.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, employeeIds],
    );
  } catch {
    // Best effort: every row uses random ids that no other file touches.
  }
  await owner.end();
});

// ===========================================================================

describe("1113 panic socket closes when the device becomes a shared tablet", () => {
  it(
    "control: a personal device keeps receiving alerts and its recheck stays ok",
    { timeout: SLOW_MS },
    async () => {
      const outlet = await world("SK control");
      const button = await registerPanicButton(outlet);
      const rx = await receiver(outlet, "SK Control");
      const session = await authenticateReceiverSession(rx.cookie);
      expect(session).not.toBeNull();
      const socket = await connect(rx.cookie);

      expect(await recheckReceiverSession(session!)).toEqual({ ok: true });
      await raise(button);
      expect(
        await socket.waitFor(() => socket.alertFrames().length > 0, WAIT_MS),
      ).toBe(true);
      expect(socket.closedWith()).toBeNull();
    },
  );

  it(
    "turning shared mode on closes the open socket (4401) and ends the session; no later alert frame arrives",
    { timeout: SLOW_MS },
    async () => {
      const outlet = await world("SK flag on");
      const button = await registerPanicButton(outlet);
      const rx = await receiver(outlet, "SK FlagOn");
      const socket = await connect(rx.cookie);

      await setDeviceSharedMode(outletScope(outlet), actor, {
        deviceId: rx.device.deviceId,
        sharedMode: true,
      });

      expect(
        await socket.waitFor(() => socket.closedWith() !== null, 5_000),
      ).toBe(true);
      expect(socket.closedWith()).toBe(PANIC_REVOKED_CLOSE_CODE);
      await raise(button);
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      expect(socket.alertFrames()).toHaveLength(0);
      // The session is gone: a new upgrade with the same cookie is refused.
      expect(await upgradeStatus(rx.cookie)).toBe(401);
    },
  );

  it(
    "a device flagged shared behind the service (SQL) fails the recheck and the next alert closes the socket without a frame",
    { timeout: SLOW_MS },
    async () => {
      const outlet = await world("SK flag sql");
      const button = await registerPanicButton(outlet);
      const rx = await receiver(outlet, "SK FlagSql");
      const session = await authenticateReceiverSession(rx.cookie);
      expect(session).not.toBeNull();
      const socket = await connect(rx.cookie);

      await setSharedBySql(rx.device.deviceId);
      await raise(button);

      expect(
        await socket.waitFor(() => socket.closedWith() !== null, 8_000),
      ).toBe(true);
      expect(socket.closedWith()).toBe(PANIC_REVOKED_CLOSE_CODE);
      expect(socket.alertFrames()).toHaveLength(0);
      expect(await recheckReceiverSession(session!)).toEqual({
        ok: false,
        reason: "device_revoked",
      });
    },
  );

  it(
    "a new upgrade from a shared device is still refused",
    { timeout: SLOW_MS },
    async () => {
      const outlet = await world("SK upgrade");
      const rx = await receiver(outlet, "SK Upgrade");
      // Session cookie is valid; flagging by SQL leaves the row unrevoked.
      await setSharedBySql(rx.device.deviceId);
      // Refused either way: 401 (recheck ends the session) or 403 (Q29 rule).
      expect([401, 403]).toContain(await upgradeStatus(rx.cookie));
    },
  );
});
