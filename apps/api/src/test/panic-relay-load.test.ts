// Emergency relay under load (cards legend-a43bt and legend-gyqdh; design
// docs/design/edge-emergency.md D-05, founder Q94). Deterministic cases: each
// race is forced with a DB trigger that delays or fails writes of ONE isolated
// tenant, never with wall-clock luck. Written from the design and the observable
// behaviour (frames, panic_alert_deliveries, panic_alerts), not the implementation.
//
// Cases:
//  PRL-H1  a receipt that arrives while the frame's delivery row is still being
//          written is recorded (no lock deadlock), inside the 5 s SLO.
//  PRL-H2  a receipt whose write failed is not lost: the alert is resent and the
//          next receipt is recorded (D-05 "resend until receipt").
//  PRL-H4  a confirmed receipt is never reset: no frame after receipt.
//  PRL-H4b recovery and a fresh press hit one socket at once: the alert still
//          counts as delivered and not as unrouted.
//  PRL-H3  NOT COVERED: the receiver-session recheck failing transiently cannot
//          be injected from outside without knowing which table it reads.
//  PRL-CLK (card gyqdh) the 15 s fallback timer, driven through the clock hook
//          `panicClock` / `setPanicClockForTest` (a fake setTimer), no real wait.
//
// ASSUMPTIONS:
//  - A DB write that fails once is observed by the user only as "no receipt
//    stored"; the design says the alert keeps coming until a receipt is stored.
//  - Clock hook shape follows the brief: panicClock.setTimer(fn, ms) is called
//    with about PANIC_FALLBACK_AFTER_MS (<= 15 s, > 14 s) when an alert is raised.
//  - Firing that timer stamps fallback_shown_at and the POS read route shows the
//    alarm (room code + time only); an acknowledgement before the timer fires
//    keeps it hidden.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import request from "supertest";
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
import { createUlid, outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { guardEdgeUpgrades } from "../edge/mode.ts";
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
import { enrollDevice } from "../services/device.service.ts";
import * as panicRelay from "../services/panic-relay.service.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_DELIVERY_BUDGET_MS,
  PANIC_FALLBACK_AFTER_MS,
  PANIC_FALLBACK_ITEM_KEYS,
  PANIC_FALLBACK_ROUTE,
  PANIC_FRAME_ALERT,
  PANIC_FRAME_RECEIVED,
  PANIC_PERMISSION_RESPOND,
  PANIC_REALTIME_ATTACH,
  PANIC_RESEND_INTERVAL_MS,
  PANIC_ROUTES,
  PANIC_WS_PROTOCOL,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";

const PIN = "582914";
const SLOW_MS = 45_000;
// Same value as PANIC_TEST_WAIT_MS on branch fix/webhook-retry-guard (commit
// 7304b5180). Defined here so this file does not touch panic-test-helpers.ts
// and cannot conflict with that branch. Upper bound for a wait the test does
// not itself time; below the 20 s default test timeout only where SLOW_MS is
// not used.
const PANIC_TEST_WAIT_MS = 15_000;

let tenant: IsolatedTenant;
const edgeApp = createApp({ edgeMode: true });
const cloudApp = createApp({ edgeMode: false });
const cloudState = getEdgeRuntimeState();

let tenantContext: ReturnType<typeof establishTenantContext>;
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });
const actor = randomUUID();

const outletIds: string[] = [];
const deviceIds: string[] = [];
const facilityIds: string[] = [];
const employeeIds: string[] = [];
const roleIds: string[] = [];
const userIds: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function asTenantOwner<T>(run: (client: PoolClient) => Promise<T>) {
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

// ---- edge process + outlet world -----------------------------------------

function actAsEdge(outletId: string) {
  setDeviceRegistryReadyForTests({});
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: outletScope(outletId),
      scope: {
        tenantId: tenant.tenantId,
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
}

const outletPeppers = new Map<string, Buffer>();
function holdEdgePepper(outlet: string) {
  let pepper = outletPeppers.get(outlet);
  if (pepper === undefined) {
    pepper = randomBytes(32);
    outletPeppers.set(outlet, pepper);
  }
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.tenantId, outlet, [{ version: 2, pepper }]);
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  outletIds.push(id);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.tenantId,
        tenant.brandId,
        tenant.legalEntityId,
        `PL-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    ),
  );
  return id;
}

async function world(label: string) {
  const outlet = await seedOutlet(label);
  holdEdgePepper(outlet);
  actAsEdge(outlet);
  return outlet;
}

// ---- devices, rooms, staff ------------------------------------------------

async function registerPanicButton(outlet: string, label = "Tombol Kamar") {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', $4, $5)`,
      [deviceId, tenant.tenantId, outlet, label, new Date(issuedAt * 1000)],
    ),
  );
  deviceIds.push(deviceId);
  const token = signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
  return { deviceId, token, label };
}

async function enrollAt(outlet: string, type: "pos" | "waiter_phone" = "pos") {
  const enrolled = await enrollDevice(outletScope(outlet), actor, {
    outletId: outlet,
    type,
    label: `Receiver ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  deviceIds.push(enrolled.device.id);
  return { token: enrolled.token, deviceId: enrolled.device.id };
}

async function seedUnit(outlet: string, panicDeviceId: string) {
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitId = randomUUID();
  facilityIds.push(facilityId);
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Panic Load', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        tenant.tenantId,
        outlet,
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
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Panic', 0)`,
      [areaId, tenant.tenantId, outlet, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order, panic_device_id)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'available', 0, $6)`,
      [unitId, tenant.tenantId, outlet, facilityId, areaId, panicDeviceId],
    );
  });
  return { facilityId, unitId };
}

const jakartaDateOf = (instantMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(instantMs),
  );

async function grantReceiverRole(userId: string, outlet: string) {
  const roleId = randomUUID();
  roleIds.push(roleId);
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, false, '["outlet"]')`,
      [
        roleId,
        tenant.tenantId,
        `Darurat ${roleId.slice(0, 8)}`,
        JSON.stringify([PANIC_PERMISSION_RESPOND]),
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

type Staff = { userId: string };

/** On-duty staff (clock-in 3 h ago) with the receiver permission and a PIN. */
async function newStaff(label: string, outlet: string): Promise<Staff> {
  const client = agent(cloudApp);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await grantReceiverRole(userId, outlet);
  const employeeId = randomUUID();
  employeeIds.push(employeeId);
  await asTenantOwner(async (c) => {
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.tenantId,
        userId,
        `PL-${employeeId.slice(0, 8).toUpperCase()}`,
        label,
        outlet,
      ],
    );
    await c.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'outlet_device', now() - make_interval(hours => 3),
               now() - make_interval(hours => 3), 'valid', '[]', $5, $6, 'none')`,
      [
        ulidToUuid(createUlid()),
        tenant.tenantId,
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
  return { userId };
}

// ---- requests -------------------------------------------------------------

const press = (token: string, body: unknown) =>
  request(edgeApp)
    .post(PANIC_ROUTES.press)
    .set(DEVICE_TOKEN_HEADER, token)
    .send(body as object);

const newEventId = () => `evt-${randomUUID()}`;

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

async function openSession(staff: Staff, device: { token: string }) {
  const res = await withEdgeModeEnv(() =>
    request(edgeApp)
      .post(PANIC_ROUTES.sessions)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send(sessionBody(staff.userId, PIN)),
  );
  expect(
    [200, 201],
    `session issue answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  return cookieOf(res);
}

async function receiverFor(outlet: string, label: string) {
  const staff = await newStaff(label, outlet);
  const device = await enrollAt(outlet);
  const cookie = await openSession(staff, device);
  return { staff, device, cookie };
}

const ackAs = (cookie: string, alertId: string) =>
  request(edgeApp)
    .post(PANIC_ROUTES.ack(alertId))
    .set(originHeader)
    .set("Cookie", cookie)
    .send({});

// ---- real WebSocket -------------------------------------------------------

let wsServer: { server: Server; port: number } | null = null;

async function startRealtime() {
  if (wsServer) return wsServer;
  const mod = (await import(
    /* @vite-ignore */ PANIC_REALTIME_ATTACH.module
  )) as Record<string, unknown>;
  const attach = mod[PANIC_REALTIME_ATTACH.exportName];
  if (typeof attach !== "function")
    throw new Error(
      `MISSING BEHAVIOUR: ${PANIC_REALTIME_ATTACH.module} does not export ${PANIC_REALTIME_ATTACH.exportName}`,
    );
  const server = createServer(edgeApp);
  guardEdgeUpgrades(server, { edgeMode: true });
  const realtime = (await (attach as (...a: unknown[]) => unknown)(server, {
    trustedOrigins: [WEB_ORIGIN],
  })) as { close?: () => void | Promise<void> } | undefined;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wsServer = { server, port: (server.address() as AddressInfo).port };
  cleanups.push(async () => {
    await realtime?.close?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wsServer = null;
  });
  return wsServer;
}

type Seen = { frame: Record<string, unknown>; at: number };

async function connect(
  cookie: string,
  options: { autoReceive?: boolean } = {},
) {
  const { port } = await startRealtime();
  const frames: Seen[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}`,
    PANIC_WS_PROTOCOL,
    { headers: { Cookie: cookie, Origin: WEB_ORIGIN }, autoPong: true },
  );
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    frames.push({ frame, at: Date.now() });
    if (
      frame.type === PANIC_FRAME_ALERT &&
      (options.autoReceive ?? true) &&
      ws.readyState === WebSocket.OPEN
    )
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
  const alertFrames = (alertId: string) =>
    frames.filter(
      (f) => f.frame.type === PANIC_FRAME_ALERT && f.frame.alertId === alertId,
    );
  const sendReceived = (alertId: string) =>
    ws.send(JSON.stringify({ type: PANIC_FRAME_RECEIVED, alertId }));
  return { ws, frames, alertFrames, sendReceived };
}

// ---- database reads -------------------------------------------------------

type AlertRow = {
  id: string;
  unrouted_since: Date | null;
  fallback_shown_at: Date | null;
  first_delivered_at: Date | null;
  delivered_count: number;
  received_at: Date;
  acknowledged_at: Date | null;
};

const alertsOf = async (deviceId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<AlertRow>(
        "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND device_id = $2 ORDER BY received_at, id",
        [tenant.tenantId, deviceId],
      ),
    )
  ).rows;

const alertById = async (alertId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<AlertRow>(
        "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, alertId],
      ),
    )
  ).rows[0];

const deliveriesOf = async (alertId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<{
        session_id: string;
        sent_count: number;
        received_at: Date | null;
      }>(
        "SELECT session_id, sent_count, received_at FROM panic_alert_deliveries WHERE tenant_id = $1 AND alert_id = $2",
        [tenant.tenantId, alertId],
      ),
    )
  ).rows;

async function raise(
  button: { deviceId: string; token: string },
  eventId = newEventId(),
) {
  const res = await press(button.token, pressBody(eventId));
  expect(
    [200, 201],
    `press answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  const rows = await alertsOf(button.deviceId);
  expect(rows.length, "an alert row exists after an accepted press").toBe(1);
  return { alert: rows[0], eventId };
}

// ---- DB fault injection (isolated tenant only) -----------------------------
// Triggers on panic_alert_deliveries act only on rows of this file's isolated
// tenant, so other test files sharing the database are never slowed or failed.
// Trigger names start with "AA_" so they fire BEFORE the foreign-key check
// trigger ("RI_ConstraintTrigger..."): the delivery row is already inserted
// (unique key taken) while the foreign-key lock on the alert row is not yet
// requested. That is the exact window where a send and a receipt can deadlock.

async function installDeliveryTrigger(kind: "slow" | "fail", arg: string) {
  const tag = randomUUID().replaceAll("-", "");
  const fn = `panic_load_${kind}_${tag}`;
  const trg = `AA_${fn}`;
  const body =
    kind === "slow"
      ? `IF NEW.tenant_id = '${tenant.tenantId}' THEN PERFORM pg_sleep(${Number(arg) / 1000}); END IF; RETURN NEW;`
      : `IF NEW.tenant_id = '${tenant.tenantId}' AND NEW.received_at IS NOT NULL
            AND clock_timestamp() < '${arg}'::timestamptz
         THEN RAISE EXCEPTION 'panic-load injected receipt failure'; END IF; RETURN NEW;`;
  await owner.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${body} END $f$`,
  );
  await owner.query(
    kind === "slow"
      ? `CREATE TRIGGER "${trg}" AFTER INSERT ON panic_alert_deliveries FOR EACH ROW EXECUTE FUNCTION ${fn}()`
      : `CREATE TRIGGER "${trg}" BEFORE INSERT OR UPDATE ON panic_alert_deliveries FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  );
  cleanups.push(async () => {
    await owner.query(
      `DROP TRIGGER IF EXISTS "${trg}" ON panic_alert_deliveries`,
    );
    await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  });
}

const slowDeliveryInsert = (ms: number) =>
  installDeliveryTrigger("slow", String(ms));
const failReceiptsFor = (ms: number) =>
  installDeliveryTrigger("fail", new Date(Date.now() + ms).toISOString());

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(
    `prload-${randomBytes(3).toString("hex")}`,
  );
  tenantContext = establishTenantContext({
    tenantId: tenant.tenantId,
    brandId: null,
    source: "session",
  });
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  setEdgeRuntimeStateForTests(cloudState);
  setDeviceRegistryReadyForTests(null);
});

afterAll(async () => {
  const { rows } = await owner.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
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
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      userIds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

// ===========================================================================
// PRL-H1 / H2 / H4: receipts under a slow or failing database
// ===========================================================================

describe("PRL-H1 a receipt that lands while the frame's delivery row is being written is recorded in time", () => {
  it(
    "PRL-H1 two receivers answer at once while each delivery insert is slow: both receipts are stored inside the 5 s SLO",
    async () => {
      const outlet = await world("PRL-H1");
      const button = await registerPanicButton(outlet);
      const one = await receiverFor(outlet, "PRLH1 One");
      const two = await receiverFor(outlet, "PRLH1 Two");
      const sockOne = await connect(one.cookie);
      const sockTwo = await connect(two.cookie);
      // The frame goes out first; the receiver answers at once while the
      // delivery row insert is still in flight (700 ms).
      await slowDeliveryInsert(700);

      const { alert } = await raise(button);

      await vi.waitFor(
        async () => {
          const rows = await deliveriesOf(alert.id);
          expect(rows).toHaveLength(2);
          for (const row of rows) expect(row.received_at).not.toBeNull();
        },
        { timeout: PANIC_TEST_WAIT_MS, interval: 100 },
      );
      for (const row of await deliveriesOf(alert.id)) {
        expect(
          (row.received_at as Date).getTime() - alert.received_at.getTime(),
          "receipt minus received_at stays under the FAC-08 budget",
        ).toBeLessThan(PANIC_DELIVERY_BUDGET_MS);
      }
      expect(sockOne.alertFrames(alert.id).length).toBeGreaterThan(0);
      expect(sockTwo.alertFrames(alert.id).length).toBeGreaterThan(0);
      expect((await alertById(alert.id)).delivered_count).toBe(2);
    },
    SLOW_MS,
  );
});

describe("PRL-H2 a receipt whose write failed is not lost", () => {
  it(
    "PRL-H2 the first receipt write fails: the alert is resent and the next receipt is stored",
    async () => {
      const outlet = await world("PRL-H2");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "PRLH2 Receiver");
      const sock = await connect(rcv.cookie);
      // Receipt writes fail for 2 s: only the first one (frame at ~0 s) is hit;
      // the resend at ~3 s ("resend until receipt", D-05) must succeed.
      await failReceiptsFor(2_000);

      const { alert } = await raise(button);

      await vi.waitFor(
        async () => {
          const rows = await deliveriesOf(alert.id);
          expect(rows[0]?.received_at ?? null).not.toBeNull();
        },
        { timeout: PANIC_TEST_WAIT_MS, interval: 250 },
      );
      expect(
        sock.alertFrames(alert.id).length,
        "the alert was sent again after the failed receipt",
      ).toBeGreaterThanOrEqual(2);
      expect((await alertById(alert.id)).acknowledged_at).toBeNull();
    },
    SLOW_MS,
  );
});

describe("PRL-H4 a confirmed receipt is never reset by a send that was still in flight", () => {
  it(
    "PRL-H4 after the receipt is stored no further frame arrives (no resend after receipt)",
    async () => {
      const outlet = await world("PRL-H4");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "PRLH4 Receiver");
      const sock = await connect(rcv.cookie);
      await slowDeliveryInsert(700);

      const { alert } = await raise(button);

      await vi.waitFor(
        async () =>
          expect((await deliveriesOf(alert.id))[0]?.received_at).not.toBeNull(),
        { timeout: PANIC_TEST_WAIT_MS, interval: 100 },
      );
      const settled = sock.alertFrames(alert.id).length;
      expect(settled).toBeGreaterThanOrEqual(1);
      // Two resend passes would fit in this wait.
      await sleep(2 * PANIC_RESEND_INTERVAL_MS + 500);
      expect(sock.alertFrames(alert.id)).toHaveLength(settled);
    },
    SLOW_MS,
  );
});

describe("PRL-H4b recovery and a press reach one socket at the same time", () => {
  it(
    "PRL-H4b a socket connecting while a press fans out still counts the alert as delivered and not unrouted",
    async () => {
      const outlet = await world("PRL-H4b");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "PRLH4b Receiver");
      // The socket is up before the press, so the alert is routed from the
      // start (EM-19: a connected socket is never "unrouted"). Every delivery
      // insert holds its send "in flight" for 3.5 s, longer than the 3 s resend
      // pass: the pass (recovery) and the press fan-out then overlap on the
      // same socket. Without a receipt (autoReceive off) the pass must run.
      const sock = await connect(rcv.cookie, { autoReceive: false });
      await slowDeliveryInsert(3_500);

      const { alert, eventId } = await raise(button);
      // A replay of the same press (EM-07) fans out again while the first
      // send is still in flight, and a late socket triggers recovery.
      const replay = await press(button.token, pressBody(eventId));
      expect([200, 201]).toContain(replay.status);
      // Late socket of the same session: recovery (open alerts) runs at once.
      const late = await connect(rcv.cookie, { autoReceive: false });
      await sleep(PANIC_RESEND_INTERVAL_MS + 1_500);

      await vi.waitFor(
        async () => {
          const rows = await deliveriesOf(alert.id);
          expect(rows.length).toBeGreaterThanOrEqual(1);
          expect(rows[0].sent_count).toBeGreaterThanOrEqual(1);
        },
        { timeout: PANIC_TEST_WAIT_MS, interval: 250 },
      );
      expect(
        (await alertById(alert.id)).unrouted_since,
        "a connected receiver is never counted as nobody",
      ).toBeNull();
      expect(
        sock.alertFrames(alert.id).length + late.alertFrames(alert.id).length,
      ).toBeGreaterThanOrEqual(1);

      // The receiver confirms: the alert counts as delivered.
      sock.sendReceived(alert.id);
      await vi.waitFor(
        async () => {
          const stored = await alertById(alert.id);
          expect(stored.delivered_count).toBeGreaterThanOrEqual(1);
          expect(stored.first_delivered_at).not.toBeNull();
        },
        { timeout: PANIC_TEST_WAIT_MS, interval: 250 },
      );
      expect((await alertById(alert.id)).unrouted_since).toBeNull();
    },
    SLOW_MS,
  );
});

describe("PRL-H5 a slow delivery write never blocks a later send of the same alert", () => {
  it(
    "PRL-H5 while the first delivery insert hangs, a replayed press and the 3 s resend each still put a frame on the socket",
    async () => {
      const outlet = await world("PRL-H5");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "PRLH5 Receiver");
      // No receipt (autoReceive off): the alert stays due for resend (D-05).
      const sock = await connect(rcv.cookie, { autoReceive: false });
      // Every delivery insert stays open for 12 s. The press HTTP answer waits
      // for the first send's delivery write, so presses are fired unawaited
      // and the frames are read from the socket, not from the press response.
      await slowDeliveryInsert(12_000);
      const panicFrames = () =>
        sock.frames.filter((f) => f.frame.type === PANIC_FRAME_ALERT);

      const eventId = newEventId();
      const firstPress = press(button.token, pressBody(eventId)).then(
        (res) => res,
      );
      await vi.waitFor(() => expect(panicFrames()).toHaveLength(1), {
        timeout: PANIC_DELIVERY_BUDGET_MS,
        interval: 50,
      });
      const alertId = String(panicFrames()[0].frame.alertId);

      // A replay of the same press (EM-07: shown again while open) is a forced
      // send. The first send's delivery write is still hanging, yet a frame
      // must go out.
      const replayPress = press(button.token, pressBody(eventId)).then(
        (res) => res,
      );
      await vi.waitFor(
        () => expect(panicFrames().length).toBeGreaterThanOrEqual(2),
        { timeout: PANIC_DELIVERY_BUDGET_MS, interval: 50 },
      );
      const afterReplay = panicFrames().length;

      // The periodic resend (about every 3 s) is not starved either: one more
      // frame arrives within a resend window while all writes still hang.
      await vi.waitFor(
        () => expect(panicFrames().length).toBeGreaterThan(afterReplay),
        { timeout: 2 * PANIC_RESEND_INTERVAL_MS + 1_500, interval: 100 },
      );
      expect(new Set(panicFrames().map((f) => f.frame.alertId))).toEqual(
        new Set([alertId]),
      );
      const [row] = await alertsOf(button.deviceId);
      expect(row.unrouted_since).toBeNull();

      // The hung writes end after 12 s; the presses are then answered.
      for (const res of await Promise.all([firstPress, replayPress]))
        expect([200, 201]).toContain(res.status);
    },
    SLOW_MS,
  );
});

// PRL-H3 (receiver-session recheck rejecting) is not covered: see the header.

// ===========================================================================
// PRL-CLK (card gyqdh): the 15 s fallback timer through the clock hook
// ===========================================================================

type Armed = { fn: () => void; ms: number };

function fakeTimers() {
  const armed: Armed[] = [];
  const hook = panicRelay as unknown as {
    setPanicClockForTest?: (p: {
      setTimer?: (fn: () => void, ms: number) => { unref(): void };
    }) => () => void;
    panicClock?: unknown;
  };
  if (
    typeof hook.setPanicClockForTest !== "function" ||
    hook.panicClock === undefined
  )
    throw new Error(
      "MISSING BEHAVIOUR: panic-relay.service.ts does not export panicClock / setPanicClockForTest",
    );
  const restore = hook.setPanicClockForTest({
    setTimer: (fn, ms) => {
      armed.push({ fn, ms });
      return { unref() {} };
    },
  });
  cleanups.push(restore);
  /** Timers armed for the fallback (about 15 s), not the 3 s resend loop. */
  const fallbackTimers = () =>
    armed.filter(
      (t) =>
        t.ms > PANIC_FALLBACK_AFTER_MS - 1_000 &&
        t.ms <= PANIC_FALLBACK_AFTER_MS,
    );
  return { armed, fallbackTimers };
}

async function readFallback(token: string) {
  const res = await request(edgeApp)
    .get(PANIC_FALLBACK_ROUTE)
    .set(DEVICE_TOKEN_HEADER, token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data?.alerts ?? []) as Array<Record<string, unknown>>;
}

describe("PRL-CLK the 15 s fallback timer (Q94) driven through the clock hook", () => {
  it("PRL-CLK the clock hook restores the real timer when asked", () => {
    const real = (
      panicRelay as unknown as { panicClock: { setTimer: unknown } }
    ).panicClock.setTimer;
    const { armed } = fakeTimers();
    expect(armed).toHaveLength(0);
    expect(
      (panicRelay as unknown as { panicClock: { setTimer: unknown } })
        .panicClock.setTimer,
    ).not.toBe(real);
    cleanups.pop()?.(); // the restore function pushed by fakeTimers
    expect(
      (panicRelay as unknown as { panicClock: { setTimer: unknown } })
        .panicClock.setTimer,
    ).toBe(real);
  });

  it(
    "PRL-CLK a press arms a 15 s timer; when it fires with no acknowledgement every POS screen of the outlet shows room and time only, other outlets do not",
    async () => {
      const { fallbackTimers } = fakeTimers();
      const outlet = await world("PRL-CLK fire");
      const other = await seedOutlet("PRL-CLK other");
      const button = await registerPanicButton(outlet);
      await seedUnit(outlet, button.deviceId);
      const posOne = await enrollAt(outlet);
      const posTwo = await enrollAt(outlet);
      const posElsewhere = await enrollAt(other);

      const { alert } = await raise(button);
      expect(
        fallbackTimers().length,
        "a press arms a server timer of PANIC_FALLBACK_AFTER_MS",
      ).toBeGreaterThanOrEqual(1);
      // Timer not fired yet: nothing on the POS screens, nothing stamped.
      expect(await readFallback(posOne.token)).toHaveLength(0);
      expect((await alertById(alert.id)).fallback_shown_at).toBeNull();

      for (const timer of fallbackTimers()) timer.fn();

      await vi.waitFor(
        async () =>
          expect((await alertById(alert.id)).fallback_shown_at).not.toBeNull(),
        { timeout: PANIC_TEST_WAIT_MS, interval: 100 },
      );
      for (const pos of [posOne, posTwo]) {
        const items = await readFallback(pos.token);
        expect(items).toHaveLength(1);
        expect(Object.keys(items[0]).sort()).toEqual(
          [...PANIC_FALLBACK_ITEM_KEYS].sort(),
        );
        expect(items[0]).toMatchObject({ alertId: alert.id, unitCode: "P1" });
      }
      // A POS of another outlet is not served by this edge: 401 (device not
      // registered here) or an empty list. Never this outlet's alarm.
      const elsewhere = await request(edgeApp)
        .get(PANIC_FALLBACK_ROUTE)
        .set(DEVICE_TOKEN_HEADER, posElsewhere.token);
      expect([200, 401, 403]).toContain(elsewhere.status);
      expect(elsewhere.body.data?.alerts ?? []).toHaveLength(0);
    },
    SLOW_MS,
  );

  it(
    "PRL-CLK a human acknowledgement before the timer fires keeps the POS screens quiet",
    async () => {
      const { fallbackTimers } = fakeTimers();
      const outlet = await world("PRL-CLK ack");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "PRLCLK Acker");
      const pos = await enrollAt(outlet);
      const { alert } = await raise(button);
      expect(fallbackTimers().length).toBeGreaterThanOrEqual(1);

      expect((await ackAs(rcv.cookie, alert.id)).status).toBe(200);
      for (const timer of fallbackTimers()) timer.fn();
      await sleep(1_000); // let a wrongly stamped fallback land

      expect((await alertById(alert.id)).fallback_shown_at).toBeNull();
      expect(await readFallback(pos.token)).toHaveLength(0);
    },
    SLOW_MS,
  );

  it(
    "PRL-CLK an automatic receipt of a phone does not cancel the fallback: only a human acknowledgement does",
    async () => {
      const { fallbackTimers } = fakeTimers();
      const outlet = await world("PRL-CLK receipt");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "PRLCLK Phone");
      const pos = await enrollAt(outlet);
      await connect(rcv.cookie, { autoReceive: true });
      const { alert } = await raise(button);
      await vi.waitFor(
        async () =>
          expect((await deliveriesOf(alert.id))[0]?.received_at).not.toBeNull(),
        { timeout: PANIC_TEST_WAIT_MS, interval: 100 },
      );

      for (const timer of fallbackTimers()) timer.fn();

      await vi.waitFor(
        async () =>
          expect((await readFallback(pos.token)).map((i) => i.alertId)).toEqual(
            [alert.id],
          ),
        { timeout: PANIC_TEST_WAIT_MS, interval: 100 },
      );
    },
    SLOW_MS,
  );
});
