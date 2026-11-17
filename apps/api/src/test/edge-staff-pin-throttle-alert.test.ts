// legend-62jtd: the `staff_pin.device_throttled` alert raised on an edge must
// reach the supervisors of THAT outlet in the cloud (card brief
// docs/briefs/978/brief.md). Fail-first: today the edge only writes the
// notification into its own database, nothing is queued for the cloud and the
// cloud applier edge/staff-pin-alert-applier.ts does not exist.
// Written from the card and the planned contract, not from the implementation.
//
// Planned contract (card + API plan)
//   - Edge: the 10th wrong PIN of one device inside the window enqueues ONE
//     outbox event: direction edge_to_cloud, kind transaction_event, name
//     `staff_pin.device_throttled`, version 1, aggregateType `staff_pin`,
//     payload strictly `{ deviceId }`. No PIN, no hash, no secret anywhere.
//   - Cloud: an applier registered by `registerStaffPinAlertEdgeApplier()`
//     checks the event scope against the sending edge node, notifies the
//     supervisors of the outlet and de-duplicates on the event id.
//
// How edge and cloud are simulated (as panic-sync.test.ts does): one test
// database plays both. The edge side is a real HTTP request
// (POST /api/staff-pins/verify) run as the registered edge node of outlet A.
// The cloud side is the queued envelope delivered through the cloud link store
// (applyInbound), exactly as a reconnect does.
//
// ASSUMPTIONS (the card leaves them open)
//   - Applier module: edge/staff-pin-alert-applier.ts exports
//     `registerStaffPinAlertEdgeApplier()` (same pattern as
//     panic-alert-applier.ts).
//   - "Outlet manager" = a user holding the `supervisor` role template with
//     outlet scope on that outlet (as edge-catalog-stale-alert.test.ts and
//     the supervisor alert path use). The alert shows up as rows in
//     `notifications` for that user.
//   - The edge may also keep a local notification of its own; every cloud
//     assertion therefore compares counts before and after the delivery.
//   - A rejected event (wrong scope, unknown field, bad payload) may either
//     throw out of applyInbound or be parked; the test only requires that no
//     notification is created and no secret leaks.
//   - The staff-pin verify route is served by the cloud-style app and is
//     reached as an edge process by setting the edge runtime state plus
//     EDGE_MODE around the request (as edge-pin-proof.test.ts group (f)).
//   - The hand-made envelopes use aggregateId = deviceId and sequence 1; each
//     test enrolls a new device so sequences never collide.
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
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "edge-pin-throttle-"));
  process.env.EDGE_SELFIE_DIR = dir;
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000001.5d1e7c00-0000-4000-8000-000000000002.5d1e7c00-0000-4000-8000-000000000003." +
    "A".repeat(43);
  return dir;
});

import { createUlid, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { registerAccessEdgeApplier } from "../edge/access-applier.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  getEdgeRuntimeState,
  setDeviceRegistryReadyForTests,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
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
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import {
  createIsolatedTenant,
  owner,
  seedTenantOutlets,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent } from "./helpers.ts";

const cloud = createApp({ edgeMode: false });
// From here on the process behaves as a cloud process unless a request is
// wrapped in asEdge().
delete process.env.EDGE_MODE;

const T = 60_000;
const PIN = "582914";
const WRONG = "907153";
const EVENT_NAME = "staff_pin.device_throttled";
const actor = randomUUID();

let tenant: IsolatedTenant; // T1: outlet A (the edge's outlet) and outlet B
let otherTenant: IsolatedTenant; // T2: outlet C
let outletA: string;
let outletB: string;
let outletC: string;
let node: AuthenticatedEdgeNode; // registered edge node of outlet A
let pepper: Buffer;
let supervisorA: string; // T1 / outlet A: must be notified
let supervisorB: string; // T1 / outlet B: must NOT be notified
let supervisorC: string; // T2 / outlet C: must NOT be notified
const createdUsers: string[] = [];
const supervisorRole = new Map<string, string>();

const tenantContext = () =>
  establishTenantContext({
    tenantId: tenant.tenantId,
    brandId: null,
    source: "session",
  });
const scopeA = () =>
  establishScopedTenantContext(tenantContext(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletA)],
  });

// ---- run as the edge ------------------------------------------------------------

/** Runs `run` as the registered edge node of outlet A (EDGE_MODE + identity). */
async function asEdge<T>(run: () => Promise<T>): Promise<T> {
  return withEdgeModeEnv(async () => {
    const saved = getEdgeRuntimeState();
    setDeviceRegistryReadyForTests({});
    setEdgeRuntimeStateForTests({
      edgeMode: true,
      identity: { context: node.context, scope: node.scope },
      link: {
        cloudLink: "disconnected",
        refused: false,
        lastConnectedAt: null,
      },
    });
    try {
      return await run();
    } finally {
      setEdgeRuntimeStateForTests(saved);
      setDeviceRegistryReadyForTests(null);
    }
  });
}

type Device = { id: string; token: string };

async function enrollEdgeDevice(label: string): Promise<Device> {
  const enrolled = await asEdge(() =>
    enrollDevice(scopeA(), actor, {
      outletId: outletA,
      type: "pos",
      label: `${label} ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    }),
  );
  return { id: enrolled.device.id, token: enrolled.token };
}

const verify = (device: Device, userId: string, pin: string) =>
  asEdge(async () =>
    agent(cloud)
      .post("/api/staff-pins/verify")
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ userId, pin }),
  );

const codeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

// ---- fixtures ---------------------------------------------------------------------

async function seedStaffWithPin(label: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [userId, label, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["outlet"]')`,
    [
      roleId,
      tenant.tenantId,
      `Staf throttle ${roleId.slice(0, 8)}`,
      JSON.stringify(["self.profile.view"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenant.tenantId, userId, roleId, outletA],
  );
  const employeeId = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Throttle', $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      employeeId,
      tenant.tenantId,
      userId,
      `TH-${employeeId.slice(0, 8).toUpperCase()}`,
      outletA,
    ],
  );
  await setStaffPin(
    tenantContext(),
    userId,
    { outletId: outletA, userId },
    { pin: PIN },
  );
  return userId;
}

/** A supervisor (role template) of one outlet of one tenant. */
async function addSupervisor(
  tenantId: string,
  outletId: string,
  name: string,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, name, `${userId}@example.test`],
  );
  let roleId = supervisorRole.get(tenantId);
  if (!roleId) {
    roleId = randomUUID();
    const role = await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
         FROM roles WHERE tenant_id = $3 AND template_key = 'supervisor'`,
      [roleId, tenantId, cafeLegendPlatformFixtures.tenant.id],
    );
    if (role.rowCount !== 1) throw new Error("No supervisor role template");
    supervisorRole.set(tenantId, roleId);
  }
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, outletId],
  );
  return userId;
}

/** Runs `run` as the migration owner with triggers and FKs off (fixtures only). */
async function asOwnerNoTriggers<R>(
  tenantId: string,
  run: (client: PoolClient) => Promise<R>,
): Promise<R> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

/** The cloud has not received anything from this edge yet (fresh registry). */
async function resetReceiveRegistry() {
  await asOwnerNoTriggers(tenant.tenantId, async (client) => {
    await client.query(
      "DELETE FROM edge_received_events WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    await client.query("DELETE FROM edge_inbound_events WHERE tenant_id = $1", [
      tenant.tenantId,
    ]);
    await client.query(
      "DELETE FROM edge_sync_conflicts WHERE tenant_id = $1 AND aggregate_type = 'staff_pin'",
      [tenant.tenantId],
    );
  });
}

// ---- reads ------------------------------------------------------------------------

type QueueRow = {
  link_seq: string;
  aggregate_id: string;
  direction: string;
  event: EventEnvelope;
};

async function staffPinQueue(): Promise<QueueRow[]> {
  const { rows } = await owner.query<QueueRow>(
    `SELECT link_seq::text, aggregate_id, direction, event
       FROM edge_outbound_queue
      WHERE tenant_id = $1 AND direction = 'edge_to_cloud' AND aggregate_type = 'staff_pin'
      ORDER BY link_seq`,
    [tenant.tenantId],
  );
  return rows;
}

type Note = { user_id: string; title: string; body: string };

// Only the throttle alert counts. A replayed or refused event also parks an
// `edge_sync_conflicts` row, and the cloud tells the supervisors about it with
// an unrelated "Konflik sinkronisasi edge" notification (category
// edge_sync_conflict). That one is not the throttle alert, so it is left out.
// Tenant/outlet isolation and de-duplication are still asserted on the
// throttle notifications of all three supervisors.
const THROTTLE_TITLE = "Perangkat outlet dibatasi karena PIN salah";

async function notes(): Promise<Note[]> {
  const { rows } = await owner.query<Note>(
    `SELECT user_id::text AS user_id, title, body FROM notifications
      WHERE tenant_id = ANY($1::uuid[])
        AND user_id = ANY($2::uuid[])
        AND title = $3`,
    [
      [tenant.tenantId, otherTenant.tenantId],
      [supervisorA, supervisorB, supervisorC],
      THROTTLE_TITLE,
    ],
  );
  return rows;
}

const countOf = (rows: Note[], userId: string) =>
  rows.filter((row) => row.user_id === userId).length;

/** Notification counts of the three supervisors, as one comparable value. */
async function counts() {
  const rows = await notes();
  return {
    a: countOf(rows, supervisorA),
    b: countOf(rows, supervisorB),
    c: countOf(rows, supervisorC),
    rows,
  };
}

// ---- cloud side: deliver queued envelopes like a reconnect ---------------------------

async function registerCloudApplier() {
  // Dynamic import: the module does not exist yet (fail-first).
  const modulePath = "../edge/staff-pin-alert-applier.ts";
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(/* @vite-ignore */ modulePath)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(
      `edge/staff-pin-alert-applier.ts is missing (legend-62jtd): ${(error as Error).message}`,
    );
  }
  // Production (runtime.ts) registers the access applier first: it classifies
  // the `staff_pin` aggregate as a transaction event; the alert applier only
  // adds its event handler.
  registerAccessEdgeApplier();
  const register = loaded.registerStaffPinAlertEdgeApplier;
  if (typeof register !== "function")
    throw new Error(
      "edge/staff-pin-alert-applier.ts must export registerStaffPinAlertEdgeApplier()",
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

/** Delivery of an event the cloud must refuse: it may throw or park it. */
async function deliverRefused(events: EventEnvelope[]) {
  try {
    await deliverToCloud(events);
  } catch (error) {
    // A missing applier is a failure of the feature, not a refusal.
    if ((error as Error).message.includes("staff-pin-alert-applier"))
      throw error;
  }
}

/** A well-formed event as the edge would queue it, for a device of outlet A. */
function throttleEvent(
  deviceId: string,
  overrides: Record<string, unknown> = {},
): EventEnvelope {
  const now = Date.now();
  const id = createUlid(now);
  return {
    id,
    tenantId: tenant.tenantId,
    outletId: outletA,
    name: EVENT_NAME,
    version: 1,
    aggregateType: "staff_pin",
    aggregateId: id,
    sequence: 1,
    occurredAt: new Date(now).toISOString(),
    actor: { type: "device", id: deviceId },
    deviceId,
    idempotencyKey: `staff-pin-throttle-${id}`,
    payloadSchemaRef: `${EVENT_NAME}.v1`,
    payload: { deviceId },
    ...overrides,
    // Overrides may be deliberately malformed, so no schema parse here.
  } as unknown as EventEnvelope;
}

// ---- edge side: one real flood, shared by two tests ----------------------------------

type Flood = { device: Device; events: EventEnvelope[]; rows: QueueRow[] };
let floodRun: Promise<Flood> | null = null;

/** 10 wrong PINs on one device (4 + 4 + 2 over three staff), then the 11th. */
function flood(): Promise<Flood> {
  floodRun ??= (async () => {
    const device = await enrollEdgeDevice("Layar banjir");
    const staff = [
      await seedStaffWithPin("Staf Banjir Satu"),
      await seedStaffWithPin("Staf Banjir Dua"),
      await seedStaffWithPin("Staf Banjir Tiga"),
    ];
    const before = (await staffPinQueue()).length;
    for (const [index, times] of [4, 4, 2].entries())
      for (let i = 0; i < times; i += 1) {
        const response = await verify(device, staff[index]!, WRONG);
        expect(response.status, JSON.stringify(response.body)).toBe(401);
        expect(codeOf(response.body)).toBe("PIN_INVALID");
      }
    const blocked = await verify(device, staff[0]!, PIN);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(codeOf(blocked.body)).toBe("PIN_DEVICE_THROTTLED");
    const rows = (await staffPinQueue()).slice(before);
    return { device, events: rows.map((row) => row.event), rows };
  })();
  return floodRun;
}

// ---- lifecycle ---------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(
    `pinthr-${randomBytes(3).toString("hex")}`,
  );
  otherTenant = await createIsolatedTenant(
    `pinthr2-${randomBytes(3).toString("hex")}`,
  );
  outletA = tenant.outletId;
  outletB = (await seedTenantOutlets(tenant.tenantId, 1))[0]!;
  outletC = otherTenant.outletId;
  supervisorA = await addSupervisor(tenant.tenantId, outletA, "Supervisor A");
  supervisorB = await addSupervisor(tenant.tenantId, outletB, "Supervisor B");
  supervisorC = await addSupervisor(
    otherTenant.tenantId,
    outletC,
    "Supervisor C",
  );
  pepper = randomBytes(32);
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.tenantId, outletA, [
    { version: 2, pepper },
  ]);
  const registered = await registerEdgeNode(scopeA(), actor, {
    outletId: outletA,
    role: "primary",
    label: "Edge throttle alert",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
}, 120_000);

beforeEach(async () => {
  resetEdgeApplierRegistryForTests();
  await resetReceiveRegistry();
});

afterEach(() => {
  resetEdgeStaffPinPeppers();
  installEdgeStaffPinPeppers(tenant.tenantId, outletA, [
    { version: 2, pepper },
  ]);
});

afterAll(async () => {
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
    for (const id of [tenant.tenantId, otherTenant.tenantId]) {
      for (const { table_name } of rows)
        await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
          id,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [id]);
    }
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

// ---- edge: the throttle queues a clean event --------------------------------------------

describe("legend-62jtd edge side", () => {
  it(
    "legend-62jtd the 10th wrong PIN queues exactly one edge_to_cloud staff_pin.device_throttled v1 event with payload {deviceId} and no secret",
    async () => {
      const { device, rows } = await flood();
      // One event for the window: the 11th (429) request adds none.
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.direction).toBe("edge_to_cloud");
      const event = eventEnvelopeSchema.parse(row!.event);
      expect(event.name).toBe(EVENT_NAME);
      expect(event.version).toBe(1);
      expect(event.aggregateType).toBe("staff_pin");
      expect(event.tenantId).toBe(tenant.tenantId);
      expect(event.outletId).toBe(outletA);
      // Strict payload: the device id and nothing else.
      expect(event.payload).toEqual({ deviceId: device.id });
      expect(Object.keys(event.payload)).toEqual(["deviceId"]);
      // No PIN (typed or right), no device token, no pepper anywhere.
      const text = JSON.stringify(row!.event);
      expect(text).not.toContain(PIN);
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain(device.token);
      expect(text).not.toContain(pepper.toString("hex"));
      expect(text).not.toContain(pepper.toString("base64"));
    },
    T,
  );

  it(
    "legend-62jtd nothing is queued while the device stays under the limit",
    async () => {
      const device = await enrollEdgeDevice("Layar tenang");
      const staff = await seedStaffWithPin("Staf Tenang");
      const before = (await staffPinQueue()).length;
      for (let i = 0; i < 4; i += 1) {
        const response = await verify(device, staff, WRONG);
        expect(response.status, JSON.stringify(response.body)).toBe(401);
      }
      expect(await staffPinQueue()).toHaveLength(before);
    },
    T,
  );
});

// ---- cloud: the applier notifies the right managers once -------------------------------

describe("legend-62jtd cloud applier", () => {
  it(
    "legend-62jtd the queued throttle event reaches the supervisor of its outlet only (other outlet and other tenant get nothing)",
    async () => {
      const { events } = await flood();
      expect(events).toHaveLength(1);
      const before = await counts();
      await deliverToCloud(events);
      const after = await counts();
      expect(after.a - before.a).toBe(1);
      expect(after.b).toBe(before.b);
      expect(after.c).toBe(before.c);
      // The text carries no secret.
      for (const note of after.rows) {
        const text = `${note.title} ${note.body}`;
        expect(text).not.toContain(PIN);
        expect(text).not.toContain(WRONG);
      }
    },
    T,
  );

  it(
    "legend-62jtd the same event delivered again does not notify twice (second reconnect, new link positions)",
    async () => {
      const device = await enrollEdgeDevice("Layar ulang");
      const event = throttleEvent(device.id);
      const before = await counts();
      await deliverToCloud([event]);
      const afterFirst = await counts();
      expect(afterFirst.a - before.a).toBe(1);
      await deliverToCloud([event]);
      await deliverToCloud([event]);
      const afterReplay = await counts();
      expect(afterReplay.a).toBe(afterFirst.a);
      expect(afterReplay.b).toBe(afterFirst.b);
      expect(afterReplay.c).toBe(afterFirst.c);
    },
    T,
  );

  it(
    "legend-62jtd the applier itself de-duplicates on event.id even when the receive registry has forgotten the event",
    async () => {
      const device = await enrollEdgeDevice("Layar registri hilang");
      const event = throttleEvent(device.id);
      const before = await counts();
      await deliverToCloud([event]);
      const afterFirst = await counts();
      expect(afterFirst.a - before.a).toBe(1);
      await resetReceiveRegistry();
      await deliverToCloud([event]);
      expect((await counts()).a).toBe(afterFirst.a);
    },
    T,
  );

  it(
    "legend-62jtd an event claiming another outlet of the same tenant does not notify anyone",
    async () => {
      const device = await enrollEdgeDevice("Layar outlet lain");
      const before = await counts();
      await deliverRefused([throttleEvent(device.id, { outletId: outletB })]);
      const after = await counts();
      expect(after.a).toBe(before.a);
      expect(after.b).toBe(before.b);
      expect(after.c).toBe(before.c);
    },
    T,
  );

  it(
    "legend-62jtd an event claiming another tenant does not notify anyone",
    async () => {
      const device = await enrollEdgeDevice("Layar tenant lain");
      const before = await counts();
      await deliverRefused([
        throttleEvent(device.id, {
          tenantId: otherTenant.tenantId,
          outletId: outletC,
        }),
      ]);
      const after = await counts();
      expect(after.a).toBe(before.a);
      expect(after.b).toBe(before.b);
      expect(after.c).toBe(before.c);
    },
    T,
  );

  it.each([
    [
      "an extra payload field (a PIN smuggled in)",
      (deviceId: string) => ({ payload: { deviceId, pin: "123456" } }),
    ],
    [
      "a payload without deviceId",
      () => ({ payload: {} as Record<string, unknown> }),
    ],
    [
      "a deviceId that is not a UUID",
      () => ({ payload: { deviceId: "not-a-device" } }),
    ],
    [
      "an unknown version",
      () => ({ version: 2, payloadSchemaRef: `${EVENT_NAME}.v2` }),
    ],
  ])(
    "legend-62jtd the cloud rejects %s: no notification and no leak, while a valid event still works",
    async (_label, mutate) => {
      const control = await enrollEdgeDevice("Layar kontrol");
      const bad = await enrollEdgeDevice("Layar ditolak");
      const before = await counts();
      // Control first: the applier is alive and delivers one valid event.
      await deliverToCloud([throttleEvent(control.id)]);
      const afterControl = await counts();
      expect(afterControl.a - before.a).toBe(1);

      await deliverRefused([throttleEvent(bad.id, mutate(bad.id))]);
      const after = await counts();
      expect(after.a).toBe(afterControl.a);
      expect(after.b).toBe(afterControl.b);
      expect(after.c).toBe(afterControl.c);
      for (const note of after.rows) {
        const text = `${note.title} ${note.body}`;
        expect(text).not.toContain("123456");
        expect(text).not.toContain(PIN);
      }
    },
    T,
  );
});
