// Fail-first tests for the Codex findings on the edge emergency alarm
// (bead legend-w5u1a, brief docs/briefs/fix-codex-edge-emergency.md). One `it`
// per item of the brief; written from the brief and the shared contract
// (panic-test-helpers.ts, packages/shared facility/emergency.ts), not from the
// implementation.
//
//  1. A cloud ACK for an outlet that has an active edge node is refused with
//     409 EDGE_NODE_ACTIVE (resolve stays allowed: it is the cloud -> edge
//     close path).
//  2. A cloud resolve is queued (cloud_to_edge) for the node that OWNS the
//     alert (panic_alerts.origin_edge_node_id), plus a copy for the oldest
//     active node when that is a different node (failover). Origin null keeps
//     the old behaviour (oldest active node).
//  3. A first send that fails (session re-check throws) must not lose the
//     alert: the resend loop recovers it from the open alerts in the DB, also
//     when the process memory is empty (restart).
//  4. The `panic_alert.delivered` event is in the edge outbox in the same
//     transaction as the receipt, not after a RAM timer (5 s).
//  5. Q94: the POS fallback still fires after 15 s without a HUMAN ack; the
//     automatic receipt of a phone does not stop it.
//
// ASSUMPTIONS (the brief is silent; each is one place to adjust):
//  - "Restart" (item 3) = the hub subscriber of the session is replaced by a
//    new one with an empty `alerts` map and `sendOpenAlertsTo` is NOT called:
//    the only way to find the alert is the DB scan in `resendDue`.
//  - The failing first send is simulated by `recheckReceiverSession` throwing
//    (a transient DB error), as `panic-review-e.test.ts` mocks that seam.
//  - The outbox event of item 4 is the `panic_alert.delivered` row in
//    `edge_outbound_queue` (direction edge_to_cloud, aggregate panic_alert),
//    which needs an active edge node row for the outlet (FK).
//  - Item 5 waits the real 15 s (no clock seam), like EM-19.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool, type PoolClient } from "pg";
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
import type { EventEnvelope } from "@starter/shared/events";
import {
  PANIC_ALERT_AGGREGATE_TYPE,
  panicAlertResolvedEvent,
} from "@starter/shared/facility";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";

// A controllable seam for the session re-check: null = the real function.
const recheckHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<unknown>),
  calls: 0,
}));
vi.mock("../services/panic-receiver-session.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../services/panic-receiver-session.ts")
    >();
  return {
    ...original,
    recheckReceiverSession: (
      ...args: Parameters<typeof original.recheckReceiverSession>
    ) => {
      if (recheckHook.fn === null)
        return original.recheckReceiverSession(...args);
      recheckHook.calls += 1;
      return recheckHook.fn() as ReturnType<
        typeof original.recheckReceiverSession
      >;
    },
  };
});

import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerPanicAlertEdgeApplier } from "../edge/panic-alert-applier.ts";
import { guardEdgeUpgrades } from "../edge/mode.ts";
import { attachEmergencyRealtime } from "../edge/panic-relay-realtime.ts";
import { subscribe, type HubSubscriber } from "../edge/panic-relay-hub.ts";
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
import { logger } from "../lib/logger.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import { resolveEmergencyAlert } from "../services/panic-alert-cloud.service.ts";
import { resendDue } from "../services/panic-relay.service.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_FALLBACK_AFTER_MS,
  PANIC_FALLBACK_ROUTE,
  PANIC_FRAME_ALERT,
  PANIC_FRAME_RECEIVED,
  PANIC_PERMISSION_RESOLVE,
  PANIC_PERMISSION_RESPOND,
  PANIC_ROUTES,
  PANIC_WS_PROTOCOL,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";

const PIN = "582914";
const tenant = cafeLegendPlatformFixtures.tenant;
const SLOW_MS = 60_000;

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

function actAsEdge(outletId: string, edgeNodeId: string = randomUUID()) {
  setDeviceRegistryReadyForTests({});
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: outletScope(outletId),
      scope: {
        tenantId: tenant.id,
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId,
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
  installEdgeStaffPinPeppers(tenant.id, outlet, [{ version: 2, pepper }]);
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `CX-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    ),
  );
  return id;
}

async function addEdgeNode(
  outlet: string,
  options: { role?: "primary" | "standby"; createdAtSql?: string } = {},
) {
  const id = randomUUID();
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, ${options.createdAtSql ?? "now()"})`,
      [
        id,
        tenant.id,
        outlet,
        options.role ?? "primary",
        `Node ${id.slice(0, 6)}`,
        randomBytes(32).toString("hex"),
      ],
    ),
  );
  return id;
}

/** A fresh outlet that this process serves as an edge (cloud link down). */
async function world(label: string, withNode = false) {
  const outlet = await seedOutlet(label);
  holdEdgePepper(outlet);
  const nodeId = withNode ? await addEdgeNode(outlet) : randomUUID();
  actAsEdge(outlet, nodeId);
  return { outlet, nodeId };
}

// ---- devices and staff -----------------------------------------------------

async function registerPanicButton(outlet: string, label = "Tombol Kamar") {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', $4, $5)`,
      [deviceId, tenant.id, outlet, label, new Date(issuedAt * 1000)],
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

const jakartaDateOf = (instantMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(instantMs),
  );

type Staff = {
  userId: string;
  client: ReturnType<typeof agent>;
};

/** Staff with a custom permission list at the outlet, a PIN and (optionally) a clock-in. */
async function newStaff(
  label: string,
  outlet: string,
  options: { permissions?: string[]; onDuty?: boolean } = {},
): Promise<Staff> {
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
        JSON.stringify(options.permissions ?? [PANIC_PERMISSION_RESPOND]),
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
        `CX-${employeeId.slice(0, 8).toUpperCase()}`,
        label,
        outlet,
      ],
    );
    if (options.onDuty !== false) {
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
    }
  });
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: outlet, userId },
    { pin: PIN },
  );
  return { userId, client };
}

// ---- requests --------------------------------------------------------------

const codeOf = (res: { body: { error?: { code?: string }; code?: string } }) =>
  res.body.error?.code ?? res.body.code;

const press = (token: string, body: unknown) =>
  request(edgeApp)
    .post(PANIC_ROUTES.press)
    .set(DEVICE_TOKEN_HEADER, token)
    .send(body as object);

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

async function receiverFor(outlet: string, label: string) {
  const staff = await newStaff(label, outlet);
  const device = await enrollAt(outlet);
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
  return { staff, device, cookie: cookieOf(res) };
}

const ackAs = (cookie: string, alertId: string) =>
  request(edgeApp)
    .post(PANIC_ROUTES.ack(alertId))
    .set(originHeader)
    .set("Cookie", cookie)
    .send({});

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

/** A receiver socket that confirms every alert frame at once ("received"). */
async function connectAutoReceive(cookie: string) {
  const { port } = await startRealtime();
  const frames: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}`,
    PANIC_WS_PROTOCOL,
    { headers: { Cookie: cookie, Origin: WEB_ORIGIN } },
  );
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
  return { ws, frames };
}

// ---- database reads --------------------------------------------------------

type AlertRow = {
  id: string;
  received_at: Date;
  first_delivered_at: Date | null;
  fallback_shown_at: Date | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  unrouted_since: Date | null;
};

const alertById = async (alertId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<AlertRow>(
        "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND id = $2",
        [tenant.id, alertId],
      ),
    )
  ).rows[0];

const deliveriesOf = async (alertId: string) =>
  (
    await asTenantOwner((c) =>
      c.query<{ received_at: Date | null }>(
        "SELECT received_at FROM panic_alert_deliveries WHERE tenant_id = $1 AND alert_id = $2",
        [tenant.id, alertId],
      ),
    )
  ).rows;

type QueueRow = {
  edge_node_id: string;
  direction: string;
  aggregate_sequence: string;
  event: { name: string; payload: Record<string, unknown> };
};

const queuedFor = async (alertId: string, direction: string) =>
  (
    await asTenantOwner((c) =>
      c.query<QueueRow>(
        `SELECT edge_node_id, direction, aggregate_sequence, event FROM edge_outbound_queue
          WHERE tenant_id = $1 AND aggregate_id = $2 AND direction = $3 ORDER BY link_seq`,
        [tenant.id, alertId, direction],
      ),
    )
  ).rows;

/** One accepted press on the edge; returns the alert row. */
async function raise(button: { deviceId: string; token: string }) {
  const res = await press(button.token, pressBody(`evt-${randomUUID()}`));
  expect(
    [200, 201],
    `press answered ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  const rows = (
    await asTenantOwner((c) =>
      c.query<AlertRow>(
        "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND device_id = $2 ORDER BY received_at, id",
        [tenant.id, button.deviceId],
      ),
    )
  ).rows;
  expect(
    rows.length,
    "an alert row exists after an accepted press",
  ).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

// ---- hub seam (as panic-review-e.test.ts) ----------------------------------

function fakeSocket(outlet: string, deviceId: string) {
  const sent: Array<{ alertId?: string }> = [];
  const subscriber: HubSubscriber = {
    session: {
      id: randomUUID(),
      tenantId: tenant.id,
      outletId: outlet,
      deviceId,
      userId: "user-codex-fix",
      pinGenerationAt: new Date(),
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
    send: (frame) => {
      sent.push(frame as { alertId?: string });
      return true;
    },
    close: () => undefined,
    alerts: new Map(),
  };
  const unsubscribe = subscribe(subscriber);
  cleanups.push(unsubscribe);
  return {
    unsubscribe,
    sentFor: (alertId: string) =>
      sent.filter((frame) => frame.alertId === alertId).length,
  };
}

// A simulated clock for resendDue: each tick is 4 s later than the one before,
// so the 3 s resend is always due.
let clock = Date.now();
const tick = () => {
  clock += 4_000;
  return resendDue(clock);
};

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setDeviceOutletResolver(createDeviceOutletResolver());
});

afterEach(async () => {
  recheckHook.fn = null;
  recheckHook.calls = 0;
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

describe("legend-w5u1a Codex fixes for the edge emergency alarm", () => {
  it("item 1: a cloud ACK for an outlet that has an active edge node is 409 EDGE_NODE_ACTIVE and acknowledges nothing; resolve stays allowed", async () => {
    const { outlet } = await world("CX1 ack", true);
    const button = await registerPanicButton(outlet);
    const responder = await newStaff("CX1 Responder", outlet, {
      permissions: [PANIC_PERMISSION_RESPOND],
      onDuty: false,
    });
    const resolver = await newStaff("CX1 Resolver", outlet, {
      permissions: [PANIC_PERMISSION_RESOLVE],
      onDuty: false,
    });
    const alert = await raise(button);

    setEdgeRuntimeStateForTests(cloudState);
    const ack = await responder.client
      .post(PANIC_ROUTES.cloudAck(outlet, alert.id))
      .set(originHeader)
      .send({});
    expect(ack.status, JSON.stringify(ack.body)).toBe(409);
    expect(codeOf(ack)).toBe("EDGE_NODE_ACTIVE");
    expect((await alertById(alert.id)).acknowledged_by).toBeNull();

    // Resolve is the cloud -> edge close path: it must NOT be refused.
    const resolve = await resolver.client
      .post(PANIC_ROUTES.cloudResolve(outlet, alert.id))
      .set(originHeader)
      .send({ note: "Aman" });
    expect(resolve.status, JSON.stringify(resolve.body)).toBe(200);
    expect((await alertById(alert.id)).resolved_at).not.toBeNull();
  });

  it("item 2: a cloud resolve is queued for the origin node of the alert plus the oldest active node when different (failover); origin = oldest gets exactly one", async () => {
    setEdgeRuntimeStateForTests(cloudState);
    const outlet = await seedOutlet("CX2 resolve target");
    const oldest = await addEdgeNode(outlet, {
      role: "primary",
      createdAtSql: "now() - interval '2 days'",
    });
    const origin = await addEdgeNode(outlet, {
      role: "standby",
      createdAtSql: "now() - interval '1 day'",
    });
    const button = await registerPanicButton(outlet);
    const insertAlert = async (originNode: string | null) => {
      const id = randomUUID();
      await asTenantOwner((client) =>
        client.query(
          `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                                     unit_code_snapshot, facility_name_snapshot, device_label_snapshot,
                                     received_at, origin_edge_node_id)
           VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas CX', 'Tombol CX', now(), $6)`,
          [id, tenant.id, outlet, button.deviceId, `evt-${id}`, originNode],
        ),
      );
      return id;
    };

    // Origin is the newer node: the event goes to it, and a copy to the oldest.
    const failoverAlert = await insertAlert(origin);
    await resolveEmergencyAlert(
      outletScope(outlet),
      outlet,
      failoverAlert,
      randomUUID(),
      "Selesai",
    );
    const failoverRows = await queuedFor(failoverAlert, "cloud_to_edge");
    expect(failoverRows.map((row) => row.edge_node_id).sort()).toEqual(
      [origin, oldest].sort(),
    );
    for (const row of failoverRows) {
      expect(row.event.name).toBe("panic_alert.resolved");
      expect(Number(row.aggregate_sequence)).toBe(1);
    }

    // Origin is the oldest active node: one event, no duplicate copy.
    const sameAlert = await insertAlert(oldest);
    await resolveEmergencyAlert(
      outletScope(outlet),
      outlet,
      sameAlert,
      randomUUID(),
      "Selesai",
    );
    expect(
      (await queuedFor(sameAlert, "cloud_to_edge")).map(
        (row) => row.edge_node_id,
      ),
    ).toEqual([oldest]);

    // Origin null keeps the old behaviour: the oldest active node.
    const legacyAlert = await insertAlert(null);
    await resolveEmergencyAlert(
      outletScope(outlet),
      outlet,
      legacyAlert,
      randomUUID(),
      "Selesai",
    );
    expect(
      (await queuedFor(legacyAlert, "cloud_to_edge")).map(
        (row) => row.edge_node_id,
      ),
    ).toEqual([oldest]);
  });

  it("item 2b: a failover copy of panic_alert.resolved for an alert this edge never held is a logged no-op: applied, no conflict row", async () => {
    const { outlet, nodeId } = await world("CX2b unknown resolve", true);
    registerPanicAlertEdgeApplier();
    const unknownAlertId = randomUUID();
    const now = new Date();
    const event = panicAlertResolvedEvent.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: tenant.id,
      outletId: outlet,
      name: panicAlertResolvedEvent.name,
      version: panicAlertResolvedEvent.version,
      aggregateType: PANIC_ALERT_AGGREGATE_TYPE,
      aggregateId: unknownAlertId,
      sequence: 1,
      occurredAt: now.toISOString(),
      actor: { type: "user", id: actor },
      deviceId: null,
      idempotencyKey: `${PANIC_ALERT_AGGREGATE_TYPE}:${unknownAlertId}:cloud:1`,
      payloadSchemaRef: panicAlertResolvedEvent.payloadSchemaRef,
      payload: {
        alertId: unknownAlertId,
        resolvedBy: actor,
        resolvedAt: now.toISOString(),
        resolutionNote: "Aman",
      },
    }) as EventEnvelope;
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    cleanups.push(() => info.mockRestore());

    const link = createDbLinkStore({
      database: db,
      context: outletScope(outlet),
      node: {
        tenantId: tenant.id,
        outletId: outletIdSchema.parse(outlet),
        edgeNodeId: nodeId,
      },
      outboundDirection: "edge_to_cloud",
    });
    const from = await link.lastReceivedInbound();
    await link.applyInbound({
      fromSeq: from,
      toSeq: from + 1,
      events: [{ linkSeq: from + 1, event }],
    });

    expect(
      info.mock.calls.some(
        ([fields]) =>
          (fields as { alertId?: string } | undefined)?.alertId ===
          unknownAlertId,
      ),
    ).toBe(true);
    const conflicts = await owner.query(
      "SELECT 1 FROM edge_sync_conflicts WHERE tenant_id = $1 AND aggregate_type = 'panic_alert' AND aggregate_id = $2",
      [tenant.id, unknownAlertId],
    );
    expect(conflicts.rows).toHaveLength(0);
    const receipts = await owner.query<{ outcome: string }>(
      "SELECT outcome FROM edge_inbound_events WHERE tenant_id = $1 AND aggregate_type = 'panic_alert' AND aggregate_id = $2",
      [tenant.id, unknownAlertId],
    );
    expect(receipts.rows.map((row) => row.outcome)).toEqual(["applied"]);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM panic_alerts WHERE tenant_id = $1 AND id = $2",
          [tenant.id, unknownAlertId],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it(
    "item 3: an alert whose first send failed is resent from the open alerts in the DB, also after a restart (empty RAM)",
    async () => {
      const { outlet } = await world("CX3 recover");
      const button = await registerPanicButton(outlet);
      const other = await registerPanicButton(outlet, "Tombol Selesai");
      const live = await enrollAt(outlet);

      // Phase A: the session re-check throws during the first send.
      recheckHook.fn = async () => {
        throw new Error("transient database error");
      };
      const first = fakeSocket(outlet, live.deviceId);
      const alert = await raise(button);
      await vi.waitFor(() => expect(recheckHook.calls).toBeGreaterThan(0), {
        timeout: 5_000,
      });
      expect(first.sentFor(alert.id)).toBe(0);

      // The database recovers: the resend loop must find the alert again.
      recheckHook.fn = async () => ({ ok: true });
      for (let i = 0; i < 3 && first.sentFor(alert.id) === 0; i += 1)
        await tick();
      expect(
        first.sentFor(alert.id),
        "alert lost after a failed first send: nothing resends it",
      ).toBeGreaterThanOrEqual(1);

      // Phase B: restart. All RAM is gone; the session reconnects with an empty
      // alert map and nothing replays the open alerts at connect.
      const acked = await raise(other);
      await asTenantOwner((c) =>
        c.query(
          "UPDATE panic_alerts SET acknowledged_at = now(), acknowledged_by = 'staff-human' WHERE tenant_id = $1 AND id = $2",
          [tenant.id, acked.id],
        ),
      );
      first.unsubscribe();
      const restarted = fakeSocket(outlet, live.deviceId);
      for (let i = 0; i < 3 && restarted.sentFor(alert.id) === 0; i += 1)
        await tick();
      expect(
        restarted.sentFor(alert.id),
        "after a restart the open alert is not recovered from the DB",
      ).toBeGreaterThanOrEqual(1);
      // An alert a human already took is not rung again.
      expect(restarted.sentFor(acked.id)).toBe(0);
    },
    SLOW_MS,
  );

  it(
    "item 3b: an open alert older than the 10 minute resend window is not sent again by the recovery scan",
    async () => {
      const { outlet } = await world("CX3b stale");
      const button = await registerPanicButton(outlet);
      const live = await enrollAt(outlet);
      // received_at is immutable (guard trigger): the old alert is inserted
      // with its old time instead of being updated afterwards.
      const alertId = randomUUID();
      await asTenantOwner((c) =>
        c.query(
          `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                                     unit_code_snapshot, facility_name_snapshot, device_label_snapshot,
                                     received_at)
           VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas CX', 'Tombol CX', now() - interval '11 minutes')`,
          [alertId, tenant.id, outlet, button.deviceId, `evt-${alertId}`],
        ),
      );
      // The session is live, so a 0 below is the window and not a failed check.
      recheckHook.fn = async () => ({ ok: true });
      const socket = fakeSocket(outlet, live.deviceId);
      await tick();
      await tick();
      expect(socket.sentFor(alertId)).toBe(0);
    },
    SLOW_MS,
  );

  it(
    "item 3c: unrouted_since is cleared when the recovery scan sends an alert nobody could receive before",
    async () => {
      const { outlet } = await world("CX3c unrouted");
      const button = await registerPanicButton(outlet);
      const live = await enrollAt(outlet);
      // Nobody is connected: the press is stored as unrouted.
      const alert = await raise(button);
      await vi.waitFor(
        async () =>
          expect((await alertById(alert.id)).unrouted_since).not.toBeNull(),
        { timeout: 5_000, interval: 100 },
      );
      // A socket shows up without the connect replay: only the scan finds it.
      // The fake session is not in the DB: the re-check must not close it.
      recheckHook.fn = async () => ({ ok: true });
      const socket = fakeSocket(outlet, live.deviceId);
      for (let i = 0; i < 3 && socket.sentFor(alert.id) === 0; i += 1)
        await tick();
      expect(socket.sentFor(alert.id)).toBeGreaterThanOrEqual(1);
      expect((await alertById(alert.id)).unrouted_since).toBeNull();
    },
    SLOW_MS,
  );

  it(
    "item 4: the panic_alert.delivered event is in the edge outbox as soon as the receipt is stored, without waiting for a timer",
    async () => {
      const { outlet } = await world("CX4 delivered", true);
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "CX4 Receiver");
      await connectAutoReceive(rcv.cookie);
      const alert = await raise(button);

      // Sanity: the outbox works (the raised event is written by the press).
      const raised = await queuedFor(alert.id, "edge_to_cloud");
      expect(
        raised.map((row) => row.event.name),
        "setup: the press must queue panic_alert.raised",
      ).toContain("panic_alert.raised");

      await vi.waitFor(
        async () => {
          expect((await deliveriesOf(alert.id))[0]?.received_at).not.toBeNull();
          expect((await alertById(alert.id)).first_delivered_at).not.toBeNull();
        },
        { timeout: 4_000, interval: 50 },
      );

      // Same transaction as the receipt: no flush timer (5 s), no restart can
      // lose it. Read at once, no waiting.
      const delivered = (await queuedFor(alert.id, "edge_to_cloud")).filter(
        (row) => row.event.name === "panic_alert.delivered",
      );
      expect(
        delivered,
        "receipt is stored but its delivered event is not in the outbox yet",
      ).toHaveLength(1);
      expect(delivered[0].event.payload).toMatchObject({
        alertId: alert.id,
        deliveredCount: 1,
        firstDeliveredAt: expect.any(String),
      });
    },
    SLOW_MS,
  );

  it(
    "item 5 (Q94): the automatic receipt of a phone does not stop the POS fallback; only a human ack does",
    async () => {
      const { outlet } = await world("CX5 fallback");
      const button = await registerPanicButton(outlet);
      const rcv = await receiverFor(outlet, "CX5 Receiver");
      const pos = await enrollAt(outlet);
      await connectAutoReceive(rcv.cookie);
      const alert = await raise(button);
      const readFallback = async () => {
        const res = await request(edgeApp)
          .get(PANIC_FALLBACK_ROUTE)
          .set(DEVICE_TOKEN_HEADER, pos.token);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (
          (res.body.data?.alerts ?? []) as Array<{ alertId: string }>
        ).map((item) => item.alertId);
      };

      // The phone confirms receipt automatically; nobody acknowledged.
      await vi.waitFor(
        async () =>
          expect((await alertById(alert.id)).first_delivered_at).not.toBeNull(),
        { timeout: 4_000, interval: 100 },
      );
      expect((await alertById(alert.id)).acknowledged_at).toBeNull();
      expect(await readFallback()).not.toContain(alert.id);

      // 15 s without a human ack: the alarm shows on the POS screens anyway.
      await vi.waitFor(
        async () =>
          expect((await alertById(alert.id)).fallback_shown_at).not.toBeNull(),
        { timeout: PANIC_FALLBACK_AFTER_MS + 6_000, interval: 500 },
      );
      expect(await readFallback()).toContain(alert.id);

      // A human takes it: the POS screens stop showing it.
      expect((await ackAs(rcv.cookie, alert.id)).status).toBe(200);
      expect(await readFallback()).not.toContain(alert.id);
    },
    SLOW_MS,
  );
});
