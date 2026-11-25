// Emergency button: edge -> cloud sync without duplicates (legend-bod, design
// docs/design/edge-emergency.md D-06 + D-09; part E3 of the test brief).
// Fail-first: the press route, the panic tables and the cloud applier do not
// exist on milestone/m1. Written from the design, not from the implementation.
//
// What is proven
//   EM-11  3 alerts + 1 acknowledgement made while the cloud is unreachable
//          are queued, drain on reconnect, and leave the cloud with exactly 3
//          alerts and 1 acknowledgement; replaying the whole queue changes
//          nothing.
//   EM-12  the room is deleted in the cloud while the edge is offline: the
//          alert is still stored (with its label snapshots) and an
//          edge_sync_conflicts row `panic_alert_unknown_ref` is written.
//   EM-18b the first press replayed on a SECOND (empty) database gets the same
//          deterministic alert id.
//   D-09   event order and sequence per alert, press_count never goes down,
//          a re-delivered `raised` resets nothing, the outbox row is written
//          in the SAME transaction as the state change, the cloud never sends
//          panic events back to the edge.
//
// How the "edge" and the "cloud" are simulated (as the other edge tests do):
// one test database plays both. The edge side is the real HTTP app
// (createApp({edgeMode:true}), EDGE_MODE=true around each request) with a
// registered edge node for the outlet. The "queued while offline" events are
// read from edge_outbound_queue (direction edge_to_cloud, aggregate_type
// panic_alert). "Cloud has never seen the alert" = the panic_alerts,
// panic_press_events and panic_alert_deliveries rows are removed (as the
// migration owner with triggers off), then the queued envelopes are delivered
// through the cloud link store (applyInbound) exactly as a reconnect does.
//
// ASSUMPTIONS (the design leaves them open):
// - Event names are `panic_alert.raised`, `.pressed`, `.delivered`,
//   `.acknowledged` (D-09); aggregate_type is `panic_alert`; the envelope
//   `sequence` equals the queue's aggregate_sequence; `raised` is sequence 1.
// - The cloud applier lives in edge/panic-alert-applier.ts and exports
//   `registerPanicAlertEdgeApplier()` (same pattern as stock-moved-applier).
// - The press route answers 2xx on first press and replay; a failing queue
//   write fails the request with a 5xx (same transaction, D-09).
// - The edge picks the registered edge node of the outlet for the queue.
// - The alert id of a press is read from panic_press_events
//   (alert_id for (tenant, device, device_event_id)), not from the response
//   body, because the response shape is not fixed.
// - Receiver session: POST sessions with the pos device token, the staff user
//   id and the PIN (sessionBody in panic-test-helpers.ts); the staff is on duty
//   by a published shift and holds facility.emergency.respond.
// - NOT covered here: `delivered_count` GREATEST needs the WebSocket frame
//   format (not fixed by the design); covered in panic-relay.test.ts (E1).
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Must run before ../config/env is first imported (imports are hoisted).
const edgeDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "panic-sync-"));
  process.env.EDGE_SELFIE_DIR = dir;
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000001.5d1e7c00-0000-4000-8000-000000000002.5d1e7c00-0000-4000-8000-000000000003." +
    "A".repeat(43);
  return dir;
});

import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { setEdgeNodeForEnvTests, withEdgeModeEnv } from "./edge-mode-env.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_PERMISSION_RESPOND,
  PANIC_ROUTES,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";

const edge = createApp({ edgeMode: true });
// From here on the process behaves as a cloud process unless a request is
// wrapped in withEdgeModeEnv.
delete process.env.EDGE_MODE;

const T = 60_000;
const PIN = "582914";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WIB_OFFSET = 7 * HOUR;
const actor = randomUUID();

let tenant: IsolatedTenant;
let outletId: string;
let node: AuthenticatedEdgeNode;
let posDevice: { id: string; token: string };
let staff: { userId: string };
let pepper: Buffer;
const createdUsers: string[] = [];

const scope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

// ---- request helpers ---------------------------------------------------------------

type Device = { id: string; token: string; label: string };

async function enrollPanicDevice(
  label: string,
  exactLabel = false,
): Promise<Device> {
  const full = exactLabel ? label : `${label} ${randomUUID().slice(0, 6)}`;
  const enrolled = await enrollDevice(scope(), actor, {
    outletId,
    type: "panic_button",
    label: full,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return { id: enrolled.device.id, token: enrolled.token, label: full };
}

const press = (device: Device, eventId: string) =>
  withEdgeModeEnv(() =>
    agent(edge)
      .post(PANIC_ROUTES.press)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send(pressBody(eventId)),
  );

async function openSession(): Promise<string> {
  const response = await withEdgeModeEnv(() =>
    agent(edge)
      .post(PANIC_ROUTES.sessions)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, posDevice.token)
      .send(sessionBody(staff.userId, PIN)),
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const cookies = ([] as string[]).concat(
    (response.headers["set-cookie"] as string[] | string | undefined) ?? [],
  );
  const cookie = cookies.find((c) => c.startsWith(`${PANIC_COOKIE_NAME}=`));
  expect(cookie, "the session sets the legend_emergency cookie").toBeDefined();
  return cookie!.split(";")[0]!;
}

const ack = (cookie: string, alertId: string) =>
  withEdgeModeEnv(() =>
    agent(edge)
      .post(PANIC_ROUTES.ack(alertId))
      .set(originHeader)
      .set("Cookie", cookie)
      .send({}),
  );

function expectOk(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    200,
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
}

// ---- database helpers ----------------------------------------------------------------

async function tableExists(name: string) {
  const { rows } = await owner.query<{ ok: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS ok",
    [`public.${name}`],
  );
  return rows[0]!.ok;
}

/** Runs `run` as the migration owner with triggers and FKs off (fixtures only). */
async function asOwnerNoTriggers<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
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

/** The cloud has never seen these alerts (a fresh database / the cloud side). */
async function wipeCloudSide() {
  await asOwnerNoTriggers(async (client) => {
    for (const table of [
      "panic_alert_deliveries",
      "panic_press_events",
      "panic_alerts",
    ])
      if (await tableExists(table))
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenant.tenantId,
        ]);
  });
}

async function resetTenantState() {
  await asOwnerNoTriggers(async (client) => {
    for (const table of [
      "panic_alert_deliveries",
      "panic_receiver_sessions",
      "panic_press_events",
      "panic_alerts",
    ])
      if (await tableExists(table))
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenant.tenantId,
        ]);
    await client.query(
      "DELETE FROM edge_outbound_queue WHERE tenant_id = $1 AND aggregate_type = 'panic_alert'",
      [tenant.tenantId],
    );
    // Isolated tenant: nothing else lives in the receive registry.
    await client.query(
      "DELETE FROM edge_received_events WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    await client.query("DELETE FROM edge_inbound_events WHERE tenant_id = $1", [
      tenant.tenantId,
    ]);
    await client.query(
      "DELETE FROM edge_sync_conflicts WHERE tenant_id = $1 AND aggregate_type = 'panic_alert'",
      [tenant.tenantId],
    );
  });
}

async function countRows(table: string): Promise<number> {
  if (!(await tableExists(table))) return 0;
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenant.tenantId],
  );
  return rows[0]!.n;
}

async function alertIdOf(device: Device, eventId: string): Promise<string> {
  const { rows } = await owner.query<{ alert_id: string }>(
    `SELECT alert_id::text AS alert_id FROM panic_press_events
      WHERE tenant_id = $1 AND device_id = $2 AND device_event_id = $3`,
    [tenant.tenantId, device.id, eventId],
  );
  expect(rows, `press ${eventId} must be stored`).toHaveLength(1);
  return rows[0]!.alert_id;
}

type QueueRow = {
  link_seq: string;
  aggregate_id: string;
  aggregate_sequence: string;
  direction: string;
  event: EventEnvelope;
};

async function panicQueue(
  direction: "edge_to_cloud" | "cloud_to_edge" = "edge_to_cloud",
): Promise<QueueRow[]> {
  const { rows } = await owner.query<QueueRow>(
    `SELECT link_seq::text, aggregate_id, aggregate_sequence::text, direction, event
       FROM edge_outbound_queue
      WHERE tenant_id = $1 AND direction = $2 AND aggregate_type = 'panic_alert'
      ORDER BY link_seq`,
    [tenant.tenantId, direction],
  );
  return rows;
}

const nameOf = (row: QueueRow) => row.event.name;

type AlertState = Record<string, unknown> & {
  id: string;
  press_count: number;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
};

async function alertRows(): Promise<AlertState[]> {
  if (!(await tableExists("panic_alerts"))) return [];
  const { rows } = await owner.query<AlertState>(
    "SELECT *, id::text AS id FROM panic_alerts WHERE tenant_id = $1 ORDER BY panic_alerts.id",
    [tenant.tenantId],
  );
  return rows;
}

async function pressEventRows() {
  if (!(await tableExists("panic_press_events"))) return [];
  const { rows } = await owner.query<{
    device_event_id: string;
    alert_id: string;
  }>(
    `SELECT device_event_id, alert_id::text AS alert_id FROM panic_press_events
      WHERE tenant_id = $1 ORDER BY device_event_id`,
    [tenant.tenantId],
  );
  return rows;
}

async function conflictReasons(): Promise<string[]> {
  const { rows } = await owner.query<{ reason: string }>(
    `SELECT reason FROM edge_sync_conflicts
      WHERE tenant_id = $1 AND aggregate_type = 'panic_alert' ORDER BY created_at`,
    [tenant.tenantId],
  );
  return rows.map((row) => row.reason);
}

/** Everything the cloud holds, as one comparable value. */
async function cloudSnapshot() {
  return JSON.stringify({
    alerts: await alertRows(),
    presses: await pressEventRows(),
    conflicts: await conflictReasons(),
  });
}

// ---- cloud side: deliver queued envelopes like a reconnect -----------------------

async function registerCloudApplier() {
  // Dynamic import: the module does not exist yet (fail-first).
  const modulePath = "../edge/panic-alert-applier.ts";
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(/* @vite-ignore */ modulePath)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(
      `edge/panic-alert-applier.ts is missing (E4): ${(error as Error).message}`,
    );
  }
  const register = loaded.registerPanicAlertEdgeApplier;
  if (typeof register !== "function")
    throw new Error(
      "edge/panic-alert-applier.ts must export registerPanicAlertEdgeApplier()",
    );
  (register as () => void)();
}

async function deliverToCloud(events: EventEnvelope[]) {
  await registerCloudApplier();
  const link = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

const queuedEvents = (rows: QueueRow[]) => rows.map((row) => row.event);

/** A new envelope for an alert, copied from a queued one (payload untouched). */
function cloneEvent(
  source: EventEnvelope,
  sequence: number,
  tag: string,
): EventEnvelope {
  const now = Date.now();
  return {
    ...source,
    id: createUlid(now),
    sequence,
    occurredAt: new Date(now).toISOString(),
    idempotencyKey: `${source.idempotencyKey}-${tag}-${randomBytes(3).toString("hex")}`,
  };
}

function maxSequenceOf(rows: QueueRow[], alertId: string): number {
  return Math.max(
    0,
    ...rows
      .filter((row) => row.aggregate_id === alertId)
      .map((row) => Number(row.aggregate_sequence)),
  );
}

// ---- edge-side scenario ----------------------------------------------------------------

/** 3 presses on 3 buttons and 1 acknowledgement (of the 2nd alert), cloud unreachable. */
async function threeAlertsOneAck() {
  const devices: Device[] = [];
  const eventIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const device = await enrollPanicDevice(`Tombol ${i + 1}`);
    const eventId = `ev-${randomUUID()}`;
    expectOk(await press(device, eventId));
    devices.push(device);
    eventIds.push(eventId);
  }
  const alertIds: string[] = [];
  for (let i = 0; i < 3; i += 1)
    alertIds.push(await alertIdOf(devices[i]!, eventIds[i]!));
  const cookie = await openSession();
  expectOk(await ack(cookie, alertIds[1]!));
  return { devices, eventIds, alertIds, ackedAlertId: alertIds[1]! };
}

// ---- fixtures -----------------------------------------------------------------------------

const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % (24 * HOUR);
  const untilMidnight = 24 * HOUR - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

async function seedStaff() {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf Darurat Sync', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Penerima darurat sync', false, NULL, $3, false, '["outlet"]')`,
    [roleId, tenant.tenantId, JSON.stringify([PANIC_PERMISSION_RESPOND])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenant.tenantId, userId, roleId, outletId],
  );
  const employeeId = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Darurat Sync', $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      employeeId,
      tenant.tenantId,
      userId,
      `PS-${employeeId.slice(0, 8).toUpperCase()}`,
      outletId,
    ],
  );
  await setStaffPin(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    userId,
    { outletId, userId },
    { pin: PIN },
  );
  await avoidOutletMidnight();
  const start = Date.now() - HOUR;
  await owner.query(
    `INSERT INTO shift_assignments
       (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
        status, source, published_by, published_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
    [
      randomUUID(),
      tenant.tenantId,
      outletId,
      employeeId,
      wibDate(Date.now()),
      JSON.stringify([
        {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 8 * HOUR).toISOString(),
        },
      ]),
      userId,
    ],
  );
  return { userId };
}

/** A room (facility, area, unit) wired to a panic button. */
async function seedRoomFor(device: Device) {
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitId = randomUUID();
  await owner.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, 'Ruang Uji Darurat', 'shower', 20, 10, 10, $4, $5, $6)`,
    [
      facilityId,
      tenant.tenantId,
      outletId,
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
  await owner.query(
    `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
     VALUES ($1, $2, $3, $4, 'Area Darurat', 0)`,
    [areaId, tenant.tenantId, outletId, facilityId],
  );
  await owner.query(
    `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order, panic_device_id)
     VALUES ($1, $2, $3, $4, $5, 'K5', 'available', 0, $6)`,
    [unitId, tenant.tenantId, outletId, facilityId, areaId, device.id],
  );
  return { facilityId, areaId, unitId };
}

async function deleteRoom(room: {
  facilityId: string;
  areaId: string;
  unitId: string;
}) {
  await asOwnerNoTriggers(async (client) => {
    await client.query(
      "DELETE FROM facility_units WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, room.unitId],
    );
    await client.query(
      "DELETE FROM facility_areas WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, room.areaId],
    );
    await client.query(
      "DELETE FROM facility_operating_hours_versions WHERE tenant_id = $1 AND facility_id = $2",
      [tenant.tenantId, room.facilityId],
    );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, room.facilityId],
    );
  });
}

/** Makes every panic_alert queue insert fail until `run` is done. */
async function withFailingQueueWrite<R>(run: () => Promise<R>): Promise<R> {
  const fn = `panic_sync_guard_${randomBytes(4).toString("hex")}`;
  await owner.query(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.tenant_id = '${tenant.tenantId}'::uuid AND NEW.aggregate_type = 'panic_alert' THEN
         RAISE EXCEPTION 'panic sync sentinel: queue write failed';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await owner.query(
    `CREATE TRIGGER ${fn} BEFORE INSERT ON edge_outbound_queue FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
  );
  try {
    return await run();
  } finally {
    await owner.query(`DROP TRIGGER ${fn} ON edge_outbound_queue`);
    await owner.query(`DROP FUNCTION public.${fn}()`);
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(
    `psync-${randomBytes(3).toString("hex")}`,
  );
  outletId = tenant.outletId;
  setEdgeNodeForEnvTests({ tenantId: tenant.tenantId, outletId: outletId });
  pepper = randomBytes(32);
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.tenantId, outletId, [
    { version: 2, pepper },
  ]);
  const registered = await registerEdgeNode(scope(), actor, {
    outletId,
    role: "primary",
    label: "Edge darurat sync",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
  // E2: devices are enrolled on the cloud, which stores the token digest.
  const enrolled = await enrollDevice(scope(), actor, {
    outletId,
    type: "pos",
    label: `Layar darurat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  posDevice = { id: enrolled.device.id, token: enrolled.token };
  staff = await seedStaff();
}, 120_000);

beforeEach(async () => {
  resetEdgeApplierRegistryForTests();
  await resetTenantState();
});

afterEach(() => {
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.tenantId, outletId, [
    { version: 2, pepper },
  ]);
});

afterAll(async () => {
  setEdgeNodeForEnvTests(null);
  resetEdgeApplierRegistryForTests();
  resetEdgeStaffPinPeppers();
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  rmSync(edgeDir, { recursive: true, force: true });
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
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
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

// ---- EM-11 --------------------------------------------------------------------------------

describe("EM-11 offline queue and reconnect", () => {
  it(
    "EM-11 3 presses and 1 acknowledgement while offline are queued as raised x3 + acknowledged x1",
    async () => {
      const { alertIds, ackedAlertId } = await threeAlertsOneAck();
      const queue = await panicQueue();
      const names = queue.map(nameOf);
      expect(names.filter((n) => n === "panic_alert.raised")).toHaveLength(3);
      expect(
        names.filter((n) => n === "panic_alert.acknowledged"),
      ).toHaveLength(1);
      expect(new Set(queue.map((r) => r.aggregate_id))).toEqual(
        new Set(alertIds),
      );
      const acknowledged = queue.find(
        (r) => nameOf(r) === "panic_alert.acknowledged",
      );
      expect(acknowledged?.aggregate_id).toBe(ackedAlertId);
      // Every event belongs to this tenant and outlet.
      for (const row of queue) {
        expect(row.event.tenantId).toBe(tenant.tenantId);
        expect(row.event.outletId).toBe(outletId);
      }
      // Event ids are fixed at enqueue: all distinct.
      expect(new Set(queue.map((r) => r.event.id)).size).toBe(queue.length);
    },
    T,
  );

  it(
    "EM-11 reconnect: the cloud ends with exactly 3 alerts and 1 acknowledgement",
    async () => {
      const { alertIds, ackedAlertId } = await threeAlertsOneAck();
      const edgeAlerts = await alertRows();
      const edgeAcked = edgeAlerts.find((a) => a.id === ackedAlertId)!;
      expect(edgeAcked.acknowledged_by).toBe(staff.userId);
      const queue = await panicQueue();

      await wipeCloudSide();
      expect(await alertRows()).toHaveLength(0);
      await deliverToCloud(queuedEvents(queue));

      const cloudAlerts = await alertRows();
      expect(cloudAlerts.map((a) => a.id).sort()).toEqual([...alertIds].sort());
      const acked = cloudAlerts.filter((a) => a.acknowledged_at !== null);
      expect(acked).toHaveLength(1);
      expect(acked[0]!.id).toBe(ackedAlertId);
      expect(acked[0]!.acknowledged_by).toBe(staff.userId);
      expect(new Date(acked[0]!.acknowledged_at!).getTime()).toBe(
        new Date(edgeAcked.acknowledged_at!).getTime(),
      );
      for (const alert of cloudAlerts) expect(alert.origin).toBe("edge");
      expect(await conflictReasons()).toEqual([]);
    },
    T,
  );

  it(
    "EM-11 replaying the whole queue (twice, and in halves) changes nothing in the cloud",
    async () => {
      await threeAlertsOneAck();
      const events = queuedEvents(await panicQueue());
      await wipeCloudSide();
      await deliverToCloud(events);
      const afterFirst = await cloudSnapshot();
      expect(JSON.parse(afterFirst).alerts).toHaveLength(3);

      await deliverToCloud(events);
      expect(await cloudSnapshot()).toBe(afterFirst);

      const middle = Math.floor(events.length / 2);
      await deliverToCloud(events.slice(0, middle));
      await deliverToCloud(events.slice(middle));
      await deliverToCloud(events);
      expect(await cloudSnapshot()).toBe(afterFirst);
      expect(await countRows("panic_alerts")).toBe(3);
    },
    T,
  );

  it(
    "EM-11 a queue drained in two parts (link dropped midway) still ends with 3 alerts and 1 acknowledgement",
    async () => {
      const { ackedAlertId } = await threeAlertsOneAck();
      const events = queuedEvents(await panicQueue());
      await wipeCloudSide();
      await deliverToCloud(events.slice(0, 2));
      expect(await countRows("panic_alerts")).toBeLessThanOrEqual(2);
      await deliverToCloud(events.slice(2));
      const alerts = await alertRows();
      expect(alerts).toHaveLength(3);
      expect(
        alerts.filter((a) => a.acknowledged_at !== null).map((a) => a.id),
      ).toEqual([ackedAlertId]);
    },
    T,
  );

  it(
    "D-09 the cloud never queues panic events back to the edge and adds no edge_to_cloud rows",
    async () => {
      await threeAlertsOneAck();
      const queue = await panicQueue();
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      expect(await panicQueue("cloud_to_edge")).toHaveLength(0);
      expect(await panicQueue()).toHaveLength(queue.length);
    },
    T,
  );
});

// ---- EM-12 --------------------------------------------------------------------------------

describe("EM-12 cloud changed while the edge was offline", () => {
  it(
    "EM-12 room deleted in the cloud: the alert is stored as sent and a panic_alert_unknown_ref conflict row is written",
    async () => {
      const device = await enrollPanicDevice("Tombol kamar");
      const room = await seedRoomFor(device);
      const eventId = `ev-${randomUUID()}`;
      expectOk(await press(device, eventId));
      const alertId = await alertIdOf(device, eventId);
      const [onEdge] = await alertRows();
      expect(onEdge!.unit_code_snapshot).toBe("K5");
      expect(onEdge!.facility_name_snapshot).toBe("Ruang Uji Darurat");
      expect(onEdge!.device_label_snapshot).toBe(device.label);
      const queue = await panicQueue();

      // While the edge was offline, a manager deleted the room in the cloud.
      await deleteRoom(room);
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));

      const cloud = await alertRows();
      expect(cloud).toHaveLength(1);
      expect(cloud[0]!.id).toBe(alertId);
      // Stored as sent: snapshots survive, nothing is rejected.
      expect(cloud[0]!.unit_code_snapshot).toBe("K5");
      expect(cloud[0]!.facility_name_snapshot).toBe("Ruang Uji Darurat");
      expect(cloud[0]!.device_label_snapshot).toBe(device.label);
      expect(cloud[0]!.unit_id).toBe(onEdge!.unit_id);
      const reasons = await conflictReasons();
      expect(reasons).toContain("panic_alert_unknown_ref");
      expect(reasons).not.toContain("applier_refused");
      // A re-delivery adds no second conflict row.
      const before = reasons.length;
      await deliverToCloud(queuedEvents(queue));
      expect((await conflictReasons()).length).toBe(before);
      expect(await countRows("panic_alerts")).toBe(1);
    },
    T,
  );

  it(
    "EM-12 control: the room still exists in the cloud, no conflict row",
    async () => {
      const device = await enrollPanicDevice("Tombol kamar utuh");
      await seedRoomFor(device);
      expectOk(await press(device, `ev-${randomUUID()}`));
      const queue = await panicQueue();
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      expect(await countRows("panic_alerts")).toBe(1);
      expect(await conflictReasons()).toEqual([]);
    },
    T,
  );

  it(
    "EM-12 the button was removed in the cloud while offline: the alert is still stored, with a conflict row",
    async () => {
      const device = await enrollPanicDevice("Tombol dicabut");
      expectOk(await press(device, `ev-${randomUUID()}`));
      const queue = await panicQueue();
      await asOwnerNoTriggers((client) =>
        client.query("DELETE FROM devices WHERE tenant_id = $1 AND id = $2", [
          tenant.tenantId,
          device.id,
        ]),
      );
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      expect(await countRows("panic_alerts")).toBe(1);
      expect(await conflictReasons()).toContain("panic_alert_unknown_ref");
    },
    T,
  );
});

describe("F-A review findings", () => {
  it(
    "F-A a 255-char button label (the devices.label maximum) is raised on the edge and applied in the cloud",
    async () => {
      const label = "L".repeat(255);
      const device = await enrollPanicDevice(label, true);
      expectOk(await press(device, `ev-${randomUUID()}`));
      const queue = await panicQueue();
      expect(queue.map(nameOf)).toEqual(["panic_alert.raised"]);
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      expect(await conflictReasons()).not.toContain("applier_refused");
      const cloud = await alertRows();
      expect(cloud).toHaveLength(1);
      expect(cloud[0]!.device_label_snapshot).toBe(label);
    },
    T,
  );

  it(
    "F-A a press already linked to another alert is kept on the first alert and a panic_press_alert_conflict row is written",
    async () => {
      const first = await enrollPanicDevice("Tombol konflik 1");
      const second = await enrollPanicDevice("Tombol konflik 2");
      expectOk(await press(first, `ev-${randomUUID()}`));
      const foldedEventId = `ev-${randomUUID()}`;
      expectOk(await press(first, foldedEventId));
      expectOk(await press(second, `ev-${randomUUID()}`));
      const queue = await panicQueue();
      const pressed = queue.find((r) => nameOf(r) === "panic_alert.pressed")!;
      const otherAlertId = (await alertRows()).find(
        (a) => a.id !== pressed.aggregate_id,
      )!.id;
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      expect(await conflictReasons()).toEqual([]);
      const linkedTo = await alertIdOf(first, foldedEventId);
      expect(linkedTo).toBe(pressed.aggregate_id);

      // The same press now arrives for a different alert.
      const stray = cloneEvent(
        pressed.event,
        maxSequenceOf(queue, otherAlertId) + 1,
        "stray",
      );
      const strayEvent = {
        ...stray,
        aggregateId: otherAlertId,
        payload: {
          ...(stray.payload as Record<string, unknown>),
          alertId: otherAlertId,
        },
      } as EventEnvelope;
      await deliverToCloud([strayEvent]);
      expect(await conflictReasons()).toEqual(["panic_press_alert_conflict"]);
      // Both alerts stay; the press stays on the first one.
      expect(await countRows("panic_alerts")).toBe(2);
      expect(await alertIdOf(first, foldedEventId)).toBe(linkedTo);
      // A re-delivery adds no second conflict row.
      await deliverToCloud([strayEvent]);
      expect(await conflictReasons()).toEqual(["panic_press_alert_conflict"]);
    },
    T,
  );
});

// ---- EM-18b -------------------------------------------------------------------------------

describe("EM-18b deterministic alert id across databases", () => {
  const V5_SHAPE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it(
    "EM-18b the same first press replayed on a second, empty database makes the same alert id",
    async () => {
      const device = await enrollPanicDevice("Tombol standby");
      const eventId = `ev-${randomUUID()}`;
      expectOk(await press(device, eventId));
      const first = await alertIdOf(device, eventId);
      expect(first).toMatch(V5_SHAPE);

      // The standby database has never seen the press.
      await wipeCloudSide();
      expect(await countRows("panic_alerts")).toBe(0);

      expectOk(await press(device, eventId));
      const second = await alertIdOf(device, eventId);
      expect(second).toBe(first);
      expect(await countRows("panic_alerts")).toBe(1);
      expect((await alertRows())[0]!.press_count).toBe(1);
    },
    T,
  );

  it(
    "EM-18b another button with the same event id, or another first event id, makes a different alert id",
    async () => {
      const a = await enrollPanicDevice("Tombol A");
      const b = await enrollPanicDevice("Tombol B");
      const sameEvent = `ev-${randomUUID()}`;
      expectOk(await press(a, sameEvent));
      expectOk(await press(b, sameEvent));
      const idA = await alertIdOf(a, sameEvent);
      const idB = await alertIdOf(b, sameEvent);
      expect(idB).not.toBe(idA);
      expect(await countRows("panic_alerts")).toBe(2);

      // Another first event id on a fresh state of the same button.
      await wipeCloudSide();
      const otherEvent = `ev-${randomUUID()}`;
      expectOk(await press(a, otherEvent));
      expect(await alertIdOf(a, otherEvent)).not.toBe(idA);
    },
    T,
  );

  it(
    "EM-18b the replayed press on the second database enqueues the same raised aggregate id",
    async () => {
      const device = await enrollPanicDevice("Tombol standby 2");
      const eventId = `ev-${randomUUID()}`;
      expectOk(await press(device, eventId));
      const first = await alertIdOf(device, eventId);
      const queue = await panicQueue();
      expect(queue.map((r) => r.aggregate_id)).toEqual([first]);

      // Standby: no state, no queue; the same press arrives.
      await resetTenantState();
      expectOk(await press(device, eventId));
      const replayQueue = await panicQueue();
      expect(replayQueue.map((r) => r.aggregate_id)).toEqual([first]);
      expect(nameOf(replayQueue[0]!)).toBe("panic_alert.raised");
      // Same alert id, so the cloud dedupes by (tenant, id): applying both
      // queues leaves one alert.
      await wipeCloudSide();
      await deliverToCloud([
        ...queuedEvents(queue),
        ...queuedEvents(replayQueue),
      ]);
      expect(await countRows("panic_alerts")).toBe(1);
    },
    T,
  );
});

// ---- D-09 ordering, monotonic counters, same-transaction outbox ----------------

describe("D-09 ordering and monotonic updates", () => {
  it(
    "D-09 raised is sequence 1, later events of an alert are consecutive, acknowledged never precedes raised",
    async () => {
      const { ackedAlertId, alertIds } = await threeAlertsOneAck();
      const queue = await panicQueue();
      for (const alertId of alertIds) {
        const own = queue.filter((r) => r.aggregate_id === alertId);
        const sequences = own.map((r) => Number(r.aggregate_sequence));
        expect(sequences).toEqual(sequences.map((_, i) => i + 1));
        expect(nameOf(own[0]!)).toBe("panic_alert.raised");
        expect(own.map((r) => Number(r.link_seq))).toEqual(
          [...own.map((r) => Number(r.link_seq))].sort((x, y) => x - y),
        );
        // The envelope carries the same sequence as the queue row.
        for (const row of own)
          expect(Number(row.event.sequence)).toBe(
            Number(row.aggregate_sequence),
          );
      }
      const ackRow = queue.find(
        (r) => nameOf(r) === "panic_alert.acknowledged",
      )!;
      const raisedRow = queue.find(
        (r) =>
          nameOf(r) === "panic_alert.raised" && r.aggregate_id === ackedAlertId,
      )!;
      expect(Number(raisedRow.link_seq)).toBeLessThan(Number(ackRow.link_seq));
    },
    T,
  );

  it(
    "D-09 a folded second press queues panic_alert.pressed (sequence 2) and the cloud ends with press_count 2",
    async () => {
      const device = await enrollPanicDevice("Tombol macet");
      const first = `ev-${randomUUID()}`;
      const second = `ev-${randomUUID()}`;
      expectOk(await press(device, first));
      expectOk(await press(device, second));
      const alertId = await alertIdOf(device, first);
      expect(await alertIdOf(device, second)).toBe(alertId);
      expect((await alertRows())[0]!.press_count).toBe(2);

      const queue = await panicQueue();
      expect(queue.map(nameOf)).toEqual([
        "panic_alert.raised",
        "panic_alert.pressed",
      ]);
      expect(queue.map((r) => Number(r.aggregate_sequence))).toEqual([1, 2]);

      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      const [cloud] = await alertRows();
      expect(cloud!.press_count).toBe(2);
      expect(await pressEventRows()).toEqual(
        [first, second]
          .sort()
          .map((device_event_id) => ({ device_event_id, alert_id: alertId })),
      );
    },
    T,
  );

  it(
    "D-09 press_count never goes down: a late pressed event with a smaller count (new event id) keeps the higher cloud value",
    async () => {
      const device = await enrollPanicDevice("Tombol monoton");
      expectOk(await press(device, `ev-${randomUUID()}`));
      expectOk(await press(device, `ev-${randomUUID()}`));
      const queue = await panicQueue();
      const pressed = queue.find((r) => nameOf(r) === "panic_alert.pressed");
      expect(
        pressed,
        "a folded press queues panic_alert.pressed",
      ).toBeDefined();
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      const alertId = (await alertRows())[0]!.id;

      // The cloud already counted 5 presses (another path reported more).
      await asOwnerNoTriggers((client) =>
        client.query(
          "UPDATE panic_alerts SET press_count = 5 WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, alertId],
        ),
      );
      const late = cloneEvent(
        pressed!.event,
        maxSequenceOf(queue, alertId) + 1,
        "late",
      );
      await deliverToCloud([late]);
      expect((await alertRows())[0]!.press_count).toBe(5);
      expect(await countRows("panic_alerts")).toBe(1);
    },
    T,
  );

  it(
    "D-09 a raised event re-delivered under a new event id resets nothing (ack, press_count, row count)",
    async () => {
      const { ackedAlertId } = await threeAlertsOneAck();
      const queue = await panicQueue();
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      const before = await cloudSnapshot();
      const raised = queue.find(
        (r) =>
          nameOf(r) === "panic_alert.raised" && r.aggregate_id === ackedAlertId,
      )!;
      const again = cloneEvent(
        raised.event,
        maxSequenceOf(queue, ackedAlertId) + 1,
        "again",
      );
      await deliverToCloud([again]);
      const cloud = await alertRows();
      expect(cloud).toHaveLength(3);
      expect(cloud.find((a) => a.id === ackedAlertId)!.acknowledged_by).toBe(
        staff.userId,
      );
      expect(JSON.parse(await cloudSnapshot()).alerts).toEqual(
        JSON.parse(before).alerts,
      );
    },
    T,
  );

  it(
    "D-09 a second acknowledgement event for the same alert never replaces the first (set once)",
    async () => {
      const { ackedAlertId } = await threeAlertsOneAck();
      const queue = await panicQueue();
      await wipeCloudSide();
      await deliverToCloud(queuedEvents(queue));
      const before = (await alertRows()).find((a) => a.id === ackedAlertId)!;
      const ackRow = queue.find(
        (r) => nameOf(r) === "panic_alert.acknowledged",
      )!;
      const rival = cloneEvent(
        ackRow.event,
        maxSequenceOf(queue, ackedAlertId) + 1,
        "rival",
      );
      // A later acknowledgement by someone else (payload carried as is, only
      // the envelope actor differs).
      rival.actor = {
        type: "user",
        id: randomUUID(),
      } as unknown as EventEnvelope["actor"];
      await deliverToCloud([rival]);
      const after = (await alertRows()).find((a) => a.id === ackedAlertId)!;
      expect(after.acknowledged_by).toBe(before.acknowledged_by);
      expect(new Date(after.acknowledged_at!).getTime()).toBe(
        new Date(before.acknowledged_at!).getTime(),
      );
    },
    T,
  );
});

describe("D-09 outbox row is written in the same transaction as the state change", () => {
  it(
    "D-09 a press whose queue write fails stores nothing (5xx); the retry stores exactly one alert and one raised event",
    async () => {
      const device = await enrollPanicDevice("Tombol tx");
      const eventId = `ev-${randomUUID()}`;
      const failed = await withFailingQueueWrite(() => press(device, eventId));
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(
        500,
      );
      expect(await countRows("panic_alerts")).toBe(0);
      expect(await countRows("panic_press_events")).toBe(0);
      expect(await panicQueue()).toHaveLength(0);

      expectOk(await press(device, eventId));
      expect(await countRows("panic_alerts")).toBe(1);
      expect(await countRows("panic_press_events")).toBe(1);
      const queue = await panicQueue();
      expect(queue.map(nameOf)).toEqual(["panic_alert.raised"]);
      expect(Number(queue[0]!.aggregate_sequence)).toBe(1);
    },
    T,
  );

  it(
    "D-09 an acknowledgement whose queue write fails leaves the alert unacknowledged (5xx); the retry acknowledges once with one event",
    async () => {
      const device = await enrollPanicDevice("Tombol tx ack");
      const eventId = `ev-${randomUUID()}`;
      expectOk(await press(device, eventId));
      const alertId = await alertIdOf(device, eventId);
      const cookie = await openSession();

      const failed = await withFailingQueueWrite(() => ack(cookie, alertId));
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(
        500,
      );
      const [unacked] = await alertRows();
      expect(unacked!.acknowledged_at).toBeNull();
      expect(unacked!.acknowledged_by).toBeNull();
      expect(
        (await panicQueue()).filter(
          (r) => nameOf(r) === "panic_alert.acknowledged",
        ),
      ).toHaveLength(0);

      expectOk(await ack(cookie, alertId));
      const [acked] = await alertRows();
      expect(acked!.acknowledged_by).toBe(staff.userId);
      expect(acked!.acknowledged_at).not.toBeNull();
      expect(
        (await panicQueue()).filter(
          (r) => nameOf(r) === "panic_alert.acknowledged",
        ),
      ).toHaveLength(1);
    },
    T,
  );

  it(
    "D-09 a folded second press whose queue write fails does not raise press_count",
    async () => {
      const device = await enrollPanicDevice("Tombol tx fold");
      expectOk(await press(device, `ev-${randomUUID()}`));
      const folded = `ev-${randomUUID()}`;
      const failed = await withFailingQueueWrite(() => press(device, folded));
      expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(
        500,
      );
      expect((await alertRows())[0]!.press_count).toBe(1);
      expect(await countRows("panic_press_events")).toBe(1);
      expect(await panicQueue()).toHaveLength(1);

      expectOk(await press(device, folded));
      expect((await alertRows())[0]!.press_count).toBe(2);
      expect((await panicQueue()).map(nameOf)).toEqual([
        "panic_alert.raised",
        "panic_alert.pressed",
      ]);
    },
    T,
  );
});
