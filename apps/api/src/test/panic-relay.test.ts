// Panic alert ingest, LAN fan-out and incident row (bead legend-bod; PRD v1.7
// F25 Keselamatan, FAC-08, TEN-01..03). Written BEFORE the implementation: it
// fails until db/schema/panic-alert.ts, services/panic-relay-hub.ts and
// services/panic-relay.service.ts and routes/edge-panic.routes.ts exist.
//
// The real Express app (edge mode), Better Auth, the RBAC resolver and
// PostgreSQL. A panic button is a registered `panic_button` device that posts
// to the edge with its X-Device-Token; staff sign in on the edge app.
//
// Assumptions where the brief (brief-bod-slice1.md) is silent:
//  - The hub key is `{ tenantId, outletId }`; `subscribe(key, send)` returns an
//    unsubscribe function, `send` receives the frame object, and
//    `publish(key, frame)` returns the number of subscribers it reached.
//  - The hub is per outlet, so "on duty only" is checked on the stored
//    `recipient_count` (clocked-in staff of the outlet: latest attendance log
//    today is `in`), and by subscribers of another outlet or tenant receiving
//    nothing.
//  - `alertId` in the frame is the alert row id, as uuid or as ULID.
//  - A first ingest answers 200 or 201, a replay 200 or 201 (never an error).
//  - A non-panic device is refused with 403 or 422, a device of another outlet
//    with 403, 404 or 422, a malformed or extra-key body with 400 or 422.
//  - "Offline" means this node reports `cloudLink: "disconnected"`; the
//    incident row then has offline = true.
//  - The ack route and `acknowledgePanicAlert` take the alert id in its uuid
//    form. `triggeredAt` is an ISO string.
//  - The "today" of the on-duty rule is the Asia/Jakarta calendar date.
//  - docs/deployment.md asks for a tenant isolation case in one of the three
//    tenant-isolation-*.test.ts files; it lives at the bottom of this file so
//    those suites keep loading while the module is missing. Move it at will.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { respondFacilityIncident } from "../services/facility-incidents.service.ts";
import { subscribe, publish } from "../services/panic-relay-hub.ts";
import {
  acknowledgePanicAlert,
  listPanicAlerts,
} from "../services/panic-relay.service.ts";
import {
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  asTenant as asLegendApp,
  createAppPool,
  createSecondTenant,
  removeSecondTenant,
  tenantContext,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const PASSWORD = "Test-password-123!";
const FAN_OUT_BUDGET_MS = 5000;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appPool = createAppPool();

const cloudApp = createApp({ edgeMode: false });
const edgeApp = createApp({ edgeMode: true });
const cloudState = getEdgeRuntimeState();

const eventsPath = "/api/edge/panic/events";
const alertsPath = "/api/edge/panic/alerts";
const ackPath = (id: string) =>
  `/api/edge/panic/alerts/${encodeURIComponent(id)}/ack`;

const baseContext = () =>
  establishTenantContext({
    tenantId: seededTenantId,
    brandId: null,
    source: "device",
  });
const scopedTo = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(baseContext(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

/** This process becomes the (offline) edge node of `outletId`. */
function actAsEdge(outletId: string = seededOutletA) {
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: scopedTo(outletId),
      scope: {
        tenantId: seededTenantId,
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
}

async function asTenantOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

const jakartaDateOf = (instantMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(instantMs),
  );

// ---- fixtures -------------------------------------------------------------

const deviceIds: string[] = [];
const facilityIds: string[] = [];
const employeeIds: string[] = [];
const roleIds: string[] = [];
const userIds: string[] = [];

async function newUser(label: string) {
  const client = agent(cloudApp);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  return { userId, email };
}

async function registerDevice(type: string, outletId: string = seededOutletA) {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, $4, 'Panic test', $5)`,
      [deviceId, seededTenantId, outletId, type, new Date(issuedAt * 1000)],
    ),
  );
  deviceIds.push(deviceId);
  const token = signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: seededTenantId,
    brandId: null,
    deviceId,
  });
  return { deviceId, token };
}

/** A facility unit of outlet A whose panic button is `panicDeviceId`. */
async function seedUnit(panicDeviceId: string) {
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitId = randomUUID();
  facilityIds.push(facilityId);
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Panic Relay', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        seededTenantId,
        seededOutletA,
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
      [areaId, seededTenantId, seededOutletA, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order, panic_device_id)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'available', 0, $6)`,
      [
        unitId,
        seededTenantId,
        seededOutletA,
        facilityId,
        areaId,
        panicDeviceId,
      ],
    );
  });
  return { facilityId, unitId };
}

/**
 * Staff member of an outlet with an HRIS employee row; `shift` sets attendance.
 * The clock-in is `inHoursAgo` hours old (a clock-out, when asked for, is 1 h
 * ago); the business date is that of the log's own instant.
 */
async function seedStaff(
  label: string,
  outletId: string,
  shift: "clocked-in" | "clocked-out",
  inHoursAgo = 3,
) {
  const user = await newUser(label);
  const employeeId = randomUUID();
  employeeIds.push(employeeId);
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        seededTenantId,
        user.userId,
        `PR-${employeeId.slice(0, 8).toUpperCase()}`,
        label,
        outletId,
      ],
    );
    const log = (type: "in" | "out", agoHours: number) =>
      client.query(
        `INSERT INTO attendance_logs
           (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
            validity, business_date, client_event_id)
         VALUES ($1, $2, $3, $4, $5, 'selfie_geo', now() - make_interval(hours => $6::int),
                 now() - make_interval(hours => $6::int), 'valid', $7, $8)`,
        [
          ulidToUuid(createUlid()),
          seededTenantId,
          outletId,
          employeeId,
          type,
          agoHours,
          jakartaDateOf(Date.now() - agoHours * 3_600_000),
          createUlid(),
        ],
      );
    await log("in", inHoursAgo);
    if (shift === "clocked-out") await log("out", 1);
  });
  return user;
}

/** Staff signed in on the edge app, MFA verified, with a seeded role template. */
async function edgeOwner(label = "Panic Owner") {
  const staff = await staffWithRole(cloudApp, {
    template: "owner",
    scopeType: "tenant",
    scopeId: null,
    label,
  });
  const client = agent(edgeApp);
  const signIn = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email: staff.email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  await verifySessionMfa(staff.email);
  return { client, userId: staff.userId };
}

/** Staff signed in on the edge app whose only permission is unrelated to panic. */
async function edgeStaffWithoutPanicRights() {
  const user = await newUser("Panic No Rights");
  const roleId = randomUUID();
  roleIds.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      seededTenantId,
      `Panic no rights ${roleId.slice(0, 8)}`,
      JSON.stringify(["floor.table.view"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [seededTenantId, user.userId, roleId, seededOutletA],
  );
  const client = agent(edgeApp);
  const signIn = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email: user.email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  await verifySessionMfa(user.email);
  return { client, userId: user.userId };
}

type PanicBody = { deviceId: string; eventId: string; triggeredAt: string };
const panicBody = (deviceId: string, eventId?: string): PanicBody => ({
  deviceId,
  eventId: eventId ?? `evt-${randomUUID()}`,
  triggeredAt: new Date().toISOString(),
});
const press = (token: string | null, body: unknown) => {
  const req = request(edgeApp).post(eventsPath);
  if (token) req.set("X-Device-Token", token);
  return req.send(body as object);
};

const alertRows = (deviceId: string, eventId: string) =>
  asTenantOwner((client) =>
    client.query<{
      id: string;
      unit_id: string | null;
      facility_incident_id: string | null;
      recipient_count: number;
      offline: boolean;
      fanned_out_ms: number | null;
      acknowledged_by: string | null;
      acknowledged_at: Date | null;
      received_at: Date;
    }>(
      `SELECT id, unit_id, facility_incident_id, recipient_count, offline,
              EXTRACT(EPOCH FROM (fanned_out_at - received_at)) * 1000 AS fanned_out_ms,
              acknowledged_by, acknowledged_at, received_at
         FROM panic_alerts
        WHERE tenant_id = $1 AND device_id = $2 AND event_id = $3`,
      [seededTenantId, deviceId, eventId],
    ),
  );

const incidentRow = (id: string) =>
  asTenantOwner((client) =>
    client.query<{
      type: string;
      unit_id: string | null;
      offline: boolean;
      responded_by: string | null;
      responded_at: Date | null;
    }>(
      `SELECT type, unit_id, offline, responded_by, responded_at
         FROM facility_incidents WHERE tenant_id = $1 AND id = $2`,
      [seededTenantId, id],
    ),
  );

const incidentCount = (unitId: string) =>
  asTenantOwner(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM facility_incidents WHERE tenant_id = $1 AND unit_id = $2",
      [seededTenantId, unitId],
    );
    return rows[0].n;
  });

/**
 * Subscribes to the panic hub of an outlet as `userId` (a staff socket); the
 * on-duty fan-out only reaches the sockets of staff on duty.
 */
function listen(
  outletId: string,
  tenantId: string = seededTenantId,
  userId: string | null = null,
) {
  const send = vi.fn();
  const unsubscribe = subscribe({ tenantId, outletId }, send, userId);
  unsubscribes.push(unsubscribe);
  return { send, unsubscribe };
}
const unsubscribes: Array<() => void> = [];

const codeOf = (res: { body: { error?: { code?: string } } }) =>
  res.body.error?.code;

let tenantB: SecondTenant;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantB = await createSecondTenant(owner, "panic");
});

afterEach(() => {
  while (unsubscribes.length > 0) unsubscribes.pop()?.();
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    await asTenantOwner(async (client) => {
      await client.query(
        "DELETE FROM panic_alerts WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
        [seededTenantId, deviceIds],
      );
      await client.query(
        "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND result_table = 'facility_incidents'",
        [seededTenantId],
      );
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'facility_incident' AND outlet_id = $2",
        [seededTenantId, seededOutletA],
      );
      for (const table of [
        "facility_incidents",
        "facility_units",
        "facility_areas",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2::uuid[])`,
          [seededTenantId, facilityIds],
        );
      await client.query(
        "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, facilityIds],
      );
      await client.query(
        "DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
        [seededTenantId, employeeIds],
      );
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, employeeIds],
      );
      await client.query(
        "DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, deviceIds],
      );
    });
    if (roleIds.length > 0) {
      await owner.query(
        "DELETE FROM role_assignments WHERE role_id = ANY($1::uuid[])",
        [roleIds],
      );
      await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
        roleIds,
      ]);
    }
  } catch {
    // Best effort: every row uses random ids that no other file touches.
  }
  try {
    await removeSecondTenant(owner, tenantB);
  } catch {
    // Best effort.
  }
  await appPool.end();
  await owner.end();
});

// ---- hub (no network: this is what keeps the relay working offline) -------

describe("legend-bod panic relay hub", () => {
  it("delivers a frame to every subscriber of the same tenant and outlet and reports the count", () => {
    const a = listen(seededOutletA);
    const b = listen(seededOutletA);
    const frame = { type: "panic", alertId: randomUUID() };
    expect(
      publish({ tenantId: seededTenantId, outletId: seededOutletA }, frame),
    ).toBe(2);
    expect(a.send).toHaveBeenCalledWith(frame);
    expect(b.send).toHaveBeenCalledWith(frame);
  });

  it("does not deliver to another outlet or another tenant", () => {
    const otherOutlet = listen(seededOutletB);
    const otherTenant = listen(seededOutletA, tenantB.tenantId);
    expect(
      publish(
        { tenantId: seededTenantId, outletId: seededOutletA },
        { type: "panic" },
      ),
    ).toBe(0);
    expect(otherOutlet.send).not.toHaveBeenCalled();
    expect(otherTenant.send).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const a = listen(seededOutletA);
    a.unsubscribe();
    expect(
      publish(
        { tenantId: seededTenantId, outletId: seededOutletA },
        { type: "panic" },
      ),
    ).toBe(0);
    expect(a.send).not.toHaveBeenCalled();
  });
});

// ---- ingest ---------------------------------------------------------------

describe("legend-bod POST /api/edge/panic/events", () => {
  it("creates the alert and the panic incident, and fans a frame out to the outlet within 5 s", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const { unitId } = await seedUnit(deviceId);
    const duty = await seedStaff("Panic Fanout", seededOutletA, "clocked-in");
    const outletListener = listen(seededOutletA, seededTenantId, duty.userId);
    const otherOutletListener = listen(seededOutletB);
    const body = panicBody(deviceId);

    const startedAt = Date.now();
    const res = await press(token, body);
    expect([200, 201]).toContain(res.status);
    await vi.waitFor(() => expect(outletListener.send).toHaveBeenCalled(), {
      timeout: FAN_OUT_BUDGET_MS,
    });
    expect(Date.now() - startedAt).toBeLessThan(FAN_OUT_BUDGET_MS);

    const { rows } = await alertRows(deviceId, body.eventId);
    expect(rows).toHaveLength(1);
    const alert = rows[0];
    expect(alert.unit_id).toBe(unitId);
    expect(alert.facility_incident_id).not.toBeNull();
    expect(alert.offline).toBe(true);
    // Server clock is authoritative: fan-out is measured on received_at.
    expect(alert.fanned_out_ms).not.toBeNull();
    expect(Number(alert.fanned_out_ms)).toBeGreaterThanOrEqual(0);
    expect(Number(alert.fanned_out_ms)).toBeLessThan(FAN_OUT_BUDGET_MS);

    const incident = await incidentRow(alert.facility_incident_id as string);
    expect(incident.rows[0]).toMatchObject({
      type: "panic",
      unit_id: unitId,
      offline: true,
      responded_by: null,
      responded_at: null,
    });

    expect(outletListener.send).toHaveBeenCalledOnce();
    const frame = outletListener.send.mock.calls[0][0];
    expect(frame).toMatchObject({
      type: "panic",
      outletId: seededOutletA,
      unitId,
      receivedAt: expect.any(String),
    });
    expect([alert.id, uuidToUlid(alert.id)]).toContain(frame.alertId);
    expect(otherOutletListener.send).not.toHaveBeenCalled();
  });

  it("a replay of the same eventId makes no second alert and no second incident", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const { unitId } = await seedUnit(deviceId);
    const duty = await seedStaff("Panic Replay", seededOutletA, "clocked-in");
    const listener = listen(seededOutletA, seededTenantId, duty.userId);
    const body = panicBody(deviceId);

    const first = await press(token, body);
    expect([200, 201]).toContain(first.status);
    expect(listener.send).toHaveBeenCalledOnce();
    const replay = await press(token, body);
    expect([200, 201]).toContain(replay.status);

    const { rows } = await alertRows(deviceId, body.eventId);
    expect(rows).toHaveLength(1);
    expect(await incidentCount(unitId)).toBe(1);
    // The frame of a replay while unacknowledged is covered below ("replay").

    // A new eventId from the same device is a new press.
    const next = await press(token, panicBody(deviceId));
    expect([200, 201]).toContain(next.status);
    expect(await incidentCount(unitId)).toBe(2);
  });

  it("a button that is not mapped to a unit still raises and fans out the alert, without an incident", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const duty = await seedStaff("Panic Unmapped", seededOutletA, "clocked-in");
    const listener = listen(seededOutletA, seededTenantId, duty.userId);
    const body = panicBody(deviceId);

    const res = await press(token, body);
    expect([200, 201]).toContain(res.status);
    const { rows } = await alertRows(deviceId, body.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_id).toBeNull();
    expect(rows[0].facility_incident_id).toBeNull();
    expect(listener.send).toHaveBeenCalledOnce();
    expect(listener.send.mock.calls[0][0]).toMatchObject({
      type: "panic",
      unitId: null,
    });
  });

  it("only staff on duty in the outlet are counted: clocked-out and other-outlet staff are not", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const one = await seedStaff("Panic On Duty 1", seededOutletA, "clocked-in");
    const two = await seedStaff("Panic On Duty 2", seededOutletA, "clocked-in");
    const out = await seedStaff(
      "Panic Clocked Out",
      seededOutletA,
      "clocked-out",
    );
    const away = await seedStaff(
      "Panic Other Outlet",
      seededOutletB,
      "clocked-in",
    );
    const oneSocket = listen(seededOutletA, seededTenantId, one.userId);
    const twoSocket = listen(seededOutletA, seededTenantId, two.userId);
    const outSocket = listen(seededOutletA, seededTenantId, out.userId);
    const awaySocket = listen(seededOutletB, seededTenantId, away.userId);
    const body = panicBody(deviceId);

    const res = await press(token, body);
    expect([200, 201]).toContain(res.status);

    const { rows } = await alertRows(deviceId, body.eventId);
    expect(rows[0].recipient_count).toBe(2);
    expect(oneSocket.send).toHaveBeenCalledOnce();
    expect(twoSocket.send).toHaveBeenCalledOnce();
    expect(outSocket.send).not.toHaveBeenCalled();
    expect(awaySocket.send).not.toHaveBeenCalled();
  });

  it("refuses a device that is not a panic button and stores nothing", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("pos");
    const listener = listen(seededOutletA);
    const body = panicBody(deviceId);

    const res = await press(token, body);
    expect([403, 422]).toContain(res.status);
    expect((await alertRows(deviceId, body.eventId)).rows).toHaveLength(0);
    expect(listener.send).not.toHaveBeenCalled();
  });

  it("refuses a panic button registered in another outlet and stores nothing", async () => {
    actAsEdge(seededOutletA);
    const { deviceId, token } = await registerDevice(
      "panic_button",
      seededOutletB,
    );
    const listener = listen(seededOutletA);
    const body = panicBody(deviceId);

    const res = await press(token, body);
    expect([403, 404, 422]).toContain(res.status);
    expect((await alertRows(deviceId, body.eventId)).rows).toHaveLength(0);
    expect(listener.send).not.toHaveBeenCalled();
  });

  it("answers 401 without a device token and 401 or 403 with a forged one", async () => {
    actAsEdge();
    const { deviceId } = await registerDevice("panic_button");
    const body = panicBody(deviceId);
    expect((await press(null, body)).status).toBe(401);
    const forged = await press("not-a-real-token", body);
    expect([401, 403]).toContain(forged.status);
    expect((await alertRows(deviceId, body.eventId)).rows).toHaveLength(0);
  });

  it("rejects a malformed or over-posted body (strict) and stores nothing", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const body = panicBody(deviceId);
    const listener = listen(seededOutletA);
    for (const bad of [
      { deviceId, triggeredAt: body.triggeredAt },
      { ...body, eventId: "" },
      { ...body, triggeredAt: "yesterday-ish" },
      { ...body, outletId: seededOutletB },
      { ...body, tenantId: tenantB.tenantId },
    ]) {
      const res = await press(token, bad);
      expect([400, 422], JSON.stringify(bad)).toContain(res.status);
    }
    expect((await alertRows(deviceId, body.eventId)).rows).toHaveLength(0);
    expect(listener.send).not.toHaveBeenCalled();
  });

  it("the cloud app does not serve the edge ingest route", async () => {
    const { deviceId, token } = await registerDevice("panic_button");
    const res = await request(cloudApp)
      .post(eventsPath)
      .set("X-Device-Token", token)
      .send(panicBody(deviceId));
    expect(res.status).toBe(404);
    expect(codeOf(res)).toBe("EDGE_ONLY_ROUTE");
  });
});

// ---- acknowledge and response time ---------------------------------------

describe("legend-bod POST /api/edge/panic/alerts/:alertId/ack", () => {
  async function raise() {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const { unitId } = await seedUnit(deviceId);
    const body = panicBody(deviceId);
    const res = await press(token, body);
    expect([200, 201]).toContain(res.status);
    const { rows } = await alertRows(deviceId, body.eventId);
    return { alert: rows[0], deviceId, unitId, body };
  }

  it("the first staff member to acknowledge wins, a second one gets 409, the same one may repeat", async () => {
    const { alert } = await raise();
    const first = await edgeOwner("Panic Ack 1");
    const second = await edgeOwner("Panic Ack 2");

    const ack = await first.client
      .post(ackPath(alert.id))
      .set(originHeader)
      .send({});
    expect(ack.status).toBe(200);

    const late = await second.client
      .post(ackPath(alert.id))
      .set(originHeader)
      .send({});
    expect(late.status).toBe(409);

    const repeat = await first.client
      .post(ackPath(alert.id))
      .set(originHeader)
      .send({});
    expect(repeat.status).toBe(200);

    const { rows } = await asTenantOwner((client) =>
      client.query<{
        acknowledged_by: string;
        response_ms: number;
      }>(
        `SELECT acknowledged_by,
                EXTRACT(EPOCH FROM (acknowledged_at - received_at)) * 1000 AS response_ms
           FROM panic_alerts WHERE tenant_id = $1 AND id = $2`,
        [seededTenantId, alert.id],
      ),
    );
    expect(rows[0].acknowledged_by).toBe(first.userId);
    // Response time = acknowledged_at - received_at (server clock), never negative.
    expect(Number(rows[0].response_ms)).toBeGreaterThanOrEqual(0);
  });

  it("the acknowledgement also marks the linked incident as responded", async () => {
    const { alert } = await raise();
    const staff = await edgeOwner("Panic Ack Incident");
    const ack = await staff.client
      .post(ackPath(alert.id))
      .set(originHeader)
      .send({});
    expect(ack.status).toBe(200);
    const incident = await incidentRow(alert.facility_incident_id as string);
    expect(incident.rows[0].responded_by).toBe(staff.userId);
    expect(incident.rows[0].responded_at).not.toBeNull();
  });

  it("needs a session (401) and the facility operate permission in the outlet (403)", async () => {
    const { alert } = await raise();
    const anonymous = await request(edgeApp)
      .post(ackPath(alert.id))
      .set(originHeader)
      .send({});
    expect(anonymous.status).toBe(401);

    const noRights = await edgeStaffWithoutPanicRights();
    const denied = await noRights.client
      .post(ackPath(alert.id))
      .set(originHeader)
      .send({});
    expect(denied.status).toBe(403);

    const stored = await asTenantOwner((client) =>
      client.query<{ acknowledged_by: string | null }>(
        "SELECT acknowledged_by FROM panic_alerts WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, alert.id],
      ),
    );
    expect(stored.rows[0].acknowledged_by).toBeNull();
  });

  it("an unknown alert id is 404", async () => {
    actAsEdge();
    const staff = await edgeOwner("Panic Ack Unknown");
    const res = await staff.client
      .post(ackPath(randomUUID()))
      .set(originHeader)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ---- list -----------------------------------------------------------------

describe("legend-bod GET /api/edge/panic/alerts", () => {
  it("lists the node outlet's alerts for staff with the permission, and refuses anonymous or unauthorised callers", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const body = panicBody(deviceId);
    expect([200, 201]).toContain((await press(token, body)).status);
    const { rows } = await alertRows(deviceId, body.eventId);

    const staff = await edgeOwner("Panic List");
    const res = await staff.client.get(alertsPath);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(rows[0].id);

    expect((await request(edgeApp).get(alertsPath)).status).toBe(401);
    const noRights = await edgeStaffWithoutPanicRights();
    expect((await noRights.client.get(alertsPath)).status).toBe(403);
  });
});

// ---- tenant isolation (TEN-01..03; docs/deployment.md "CI quality checks") -

describe("legend-bod tenant isolation", () => {
  it("tenant B cannot list or acknowledge tenant A's alert (service 404, RLS as legend_app)", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const body = panicBody(deviceId);
    expect([200, 201]).toContain((await press(token, body)).status);
    const { rows } = await alertRows(deviceId, body.eventId);
    const alertId = rows[0].id;

    // Service: a context minted for tenant B, then for another outlet of A.
    const contextB = tenantContext(tenantB.tenantId);
    await expect(
      acknowledgePanicAlert(contextB, randomUUID(), alertId, new Date()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      acknowledgePanicAlert(
        scopedTo(seededOutletB),
        randomUUID(),
        alertId,
        new Date(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const listedB = await listPanicAlerts(
      contextB,
      tenantB.outletId as never,
      {
        limit: 50,
      } as never,
    );
    expect(JSON.stringify(listedB)).not.toContain(alertId);
    const listedOtherOutlet = await listPanicAlerts(
      scopedTo(seededOutletB),
      seededOutletB as never,
      { limit: 50 } as never,
    );
    expect(JSON.stringify(listedOtherOutlet)).not.toContain(alertId);

    // Database: row level security as the restricted legend_app login.
    const select = "SELECT id FROM panic_alerts WHERE id = $1";
    const asA = await asLegendApp(appPool, seededTenantId, (c) =>
      c.query(select, [alertId]),
    );
    expect(asA.rowCount).toBe(1);
    const asB = await asLegendApp(appPool, tenantB.tenantId, (c) =>
      c.query(select, [alertId]),
    );
    expect(asB.rowCount).toBe(0);
    // No tenant set: app.require_tenant_id() raises, so nothing is readable.
    await expect(
      asLegendApp(appPool, null, (c) => c.query(select, [alertId])),
    ).rejects.toThrow(/tenant context is required/i);
    const updatedByB = await asLegendApp(appPool, tenantB.tenantId, (c) =>
      c.query(
        "UPDATE panic_alerts SET acknowledged_by = 'intruder' WHERE id = $1",
        [alertId],
      ),
    );
    expect(updatedByB.rowCount).toBe(0);

    // Outlet level: a session limited to outlet B of tenant A sees nothing.
    const asOtherOutlet = await asLegendApp(
      appPool,
      seededTenantId,
      (c) => c.query(select, [alertId]),
      [seededOutletB],
    );
    expect(asOtherOutlet.rowCount).toBe(0);

    const stored = await alertRows(deviceId, body.eventId);
    expect(stored.rows[0].acknowledged_by).toBeNull();
  });
});

// ---- architect review fixes (legend-bod) ----------------------------------

describe("legend-bod fan-out reaches the sockets of staff on duty only", () => {
  it("hub: publish with userIds delivers to those users' sockets and counts them", () => {
    const key = { tenantId: seededTenantId, outletId: seededOutletA };
    const alice = listen(seededOutletA, seededTenantId, "user-alice");
    const aliceToo = listen(seededOutletA, seededTenantId, "user-alice");
    const bob = listen(seededOutletA, seededTenantId, "user-bob");
    const anonymous = listen(seededOutletA);
    const frame = { type: "panic" };
    expect(publish(key, frame, { userIds: ["user-alice"] })).toBe(2);
    expect(alice.send).toHaveBeenCalledWith(frame);
    expect(aliceToo.send).toHaveBeenCalledWith(frame);
    expect(bob.send).not.toHaveBeenCalled();
    expect(anonymous.send).not.toHaveBeenCalled();
    expect(publish(key, frame, { userIds: [] })).toBe(0);
  });

  it("recipient_count is the number of sockets that got the frame, not the attendance list", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const connected = await seedStaff(
      "Panic Socket",
      seededOutletA,
      "clocked-in",
    );
    await seedStaff("Panic No Socket", seededOutletA, "clocked-in");
    const out = await seedStaff(
      "Panic Socket Out",
      seededOutletA,
      "clocked-out",
    );
    const onDuty = listen(seededOutletA, seededTenantId, connected.userId);
    const clockedOut = listen(seededOutletA, seededTenantId, out.userId);
    const body = panicBody(deviceId);

    expect([200, 201]).toContain((await press(token, body)).status);

    const { rows } = await alertRows(deviceId, body.eventId);
    expect(rows[0].recipient_count).toBe(1);
    expect(rows[0].fanned_out_ms).not.toBeNull();
    expect(onDuty.send).toHaveBeenCalledOnce();
    expect(clockedOut.send).not.toHaveBeenCalled();
  });
});

describe("legend-bod on duty is the latest log of the last 18 hours", () => {
  it("a night shift that began before midnight still counts; an older clock-in does not", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    // Business date of the 17 h old clock-in is yesterday (or today).
    const night = await seedStaff(
      "Panic Night",
      seededOutletA,
      "clocked-in",
      17,
    );
    const stale = await seedStaff(
      "Panic Stale",
      seededOutletA,
      "clocked-in",
      20,
    );
    const nightSocket = listen(seededOutletA, seededTenantId, night.userId);
    const staleSocket = listen(seededOutletA, seededTenantId, stale.userId);
    const body = panicBody(deviceId);

    expect([200, 201]).toContain((await press(token, body)).status);

    const { rows } = await alertRows(deviceId, body.eventId);
    expect(rows[0].recipient_count).toBe(1);
    expect(nightSocket.send).toHaveBeenCalledOnce();
    expect(staleSocket.send).not.toHaveBeenCalled();
  });
});

describe("legend-bod an acknowledgement does not block the incident resolve", () => {
  async function ackedAlert() {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    await seedUnit(deviceId);
    const body = panicBody(deviceId);
    expect([200, 201]).toContain((await press(token, body)).status);
    const { rows } = await alertRows(deviceId, body.eventId);
    const acker = await edgeOwner("Panic Acker");
    const other = await edgeOwner("Panic Other Resolver");
    const ack = await acker.client
      .post(ackPath(rows[0].id))
      .set(originHeader)
      .send({});
    expect(ack.status).toBe(200);
    return { alert: rows[0], acker, other };
  }

  it("the staff member who acknowledged can resolve the incident once; someone else gets 409", async () => {
    const { alert, acker, other } = await ackedAlert();
    const incidentId = alert.facility_incident_id as string;
    const context = scopedTo(seededOutletA);
    const acked = (await incidentRow(incidentId)).rows[0];
    expect(acked.responded_by).toBe(acker.userId);

    await expect(
      respondFacilityIncident(context, other.userId, incidentId, {
        resolution: "Saya tangani",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const resolved = await respondFacilityIncident(
      context,
      acker.userId,
      incidentId,
      { resolution: "Tamu aman" },
    );
    expect(resolved).toMatchObject({
      respondedBy: acker.userId,
      resolution: "Tamu aman",
    });
    // The acknowledgement time is kept (it is the response time).
    expect(new Date(resolved.respondedAt as string).getTime()).toBe(
      acked.responded_at?.getTime(),
    );

    // Resolved: a different resolution is refused, the same one is idempotent.
    await expect(
      respondFacilityIncident(context, acker.userId, incidentId, {
        resolution: "Lain lagi",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      respondFacilityIncident(context, acker.userId, incidentId, {
        resolution: "Tamu aman",
      }),
    ).resolves.toMatchObject({ resolution: "Tamu aman" });
  });
});

describe("legend-bod a replay of an unacknowledged press shows it again", () => {
  it("re-publishes to the staff on duty and answers replayed; stops once it is acknowledged", async () => {
    actAsEdge();
    const { deviceId, token } = await registerDevice("panic_button");
    const duty = await seedStaff("Panic Again", seededOutletA, "clocked-in");
    const socket = listen(seededOutletA, seededTenantId, duty.userId);
    const body = panicBody(deviceId);

    const first = await press(token, body);
    expect([200, 201]).toContain(first.status);
    expect(first.body.data.replayed).toBe(false);
    expect(socket.send).toHaveBeenCalledTimes(1);

    const again = await press(token, body);
    expect([200, 201]).toContain(again.status);
    expect(again.body.data.replayed).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.send.mock.calls[1][0]).toEqual(socket.send.mock.calls[0][0]);
    expect((await alertRows(deviceId, body.eventId)).rows).toHaveLength(1);

    const { rows } = await alertRows(deviceId, body.eventId);
    const staff = await edgeOwner("Panic Replay Acker");
    const ack = await staff.client
      .post(ackPath(rows[0].id))
      .set(originHeader)
      .send({});
    expect(ack.status).toBe(200);

    const late = await press(token, body);
    expect([200, 201]).toContain(late.status);
    expect(late.body.data.replayed).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(2);
  });
});
