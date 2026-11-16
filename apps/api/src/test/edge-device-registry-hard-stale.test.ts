// legend-2lgu: hard limit on a stale device-registry replica on the edge.
// Written from the brief (briefB, "Keputusan desain") and the shared edge
// endpoints, not from the implementation. Pattern copied from
// edge-registry-pull.test.ts: cloud and edge share one test database, the
// "cloud" is a fetch spy, the edge is booted with startEdgeRuntime.
//
// Rule under test: when the edge has not pulled the registry for longer than
// EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS (hard stale), a NEW device session
// (heartbeat from a device with no live heartbeat in the last 5 minutes) is
// refused with 503 EDGE_DEVICE_REGISTRY_STALE. A device that is already live
// keeps working. The cloud is never affected.
//
// Assumptions (brief ambiguities):
//  - `parseEdgeRuntimeConfig(env)` answers `{ok, config}` / `{ok:false, problems}`
//    and `config.deviceRegistryMaxStaleMs` holds the limit in milliseconds.
//  - "Live heartbeat" is read from `devices.last_seen_at` (window 5 minutes):
//    the tests set it directly instead of waiting for real heartbeats.
//  - The 503 answer is `{ error: { code, message } }` like other API errors,
//    message is the exact Indonesian text of the brief.
//  - A refused heartbeat does not touch `last_seen_at`.
//  - The alert is a notification row for the outlet's supervisor; its id is
//    deterministic per outlet and day, so repeated refusals do not add rows.
//  - (the status of a process without an edge runtime answers 503, so that case is not tested)
//  - GET /api/edge/status carries `deviceRegistry.hardStale` and
//    `deviceRegistry.maxStaleSeconds`.
//  - enrollDevice/issueDeviceToken refuse with the same message on a hard
//    stale edge (asserted by message, not by error class).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  cafeLegendFixtures,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import {
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  startEdgeRuntime,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice, issueDeviceToken } from "../services/device.service.ts";
import { listDeviceRecordsSince } from "../services/edge-device-sync.ts";
import { saveDeviceRegistryCheckpoint } from "../services/edge-device-sync-store.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { simulateEdgeModifierRecipeFk } from "./helpers/edge-database.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
// Own outlet cloned from the fixture outlet (see edge-registry-pull.test.ts).
const outletA: string = randomUUID();
const actor = randomUUID();
const supervisorUserId = randomUUID();

const CLOUD_LINK_URL = "wss://cloud.hard-stale.test/api/edge-link";
const STALE_MESSAGE =
  "Data perangkat di edge sudah terlalu lama tidak diperbarui dari cloud. Sambungkan edge ke cloud, lalu coba lagi.";
const MIN = 60_000;
const HOUR = 3_600_000;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const baseContext = (source: "session" | "device") =>
  establishTenantContext({ tenantId, brandId: null, source });
const scoped = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(baseContext(source), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
const cloudScope = () => scoped("session", outletA);
const edgeScope = () => scoped("device", outletA);

async function asOwner(text: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function enroll(label?: string) {
  return enrollDevice(cloudScope(), actor, {
    outletId: outletA,
    type: "pos",
    label: label ?? `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
}

/** Sets the device's newest heartbeat; null = never had one. */
const setLastSeen = (deviceId: string, at: Date | null) =>
  asOwner("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [deviceId, at]);

const lastSeenOf = async (deviceId: string) =>
  (await asOwner("SELECT last_seen_at FROM devices WHERE id = $1", [deviceId]))
    .rows[0]?.last_seen_at as Date | null;

let node: { id: string; credential: string };

const nodeKey = () => ({
  tenantId,
  outletId: outletIdSchema.parse(outletA),
  edgeNodeId: node.id,
});

const exportNow = () => ({
  now: new Date(Date.now() + 10 * MIN),
  settleMs: 0,
});

/** A healthy cloud: answers the registry endpoint from the shared database. */
async function cloudAnswer(input: unknown): Promise<Response> {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url,
  );
  const page = await listDeviceRecordsSince(
    nodeKey(),
    {
      since: url.searchParams.get("since") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? "100"),
    },
    exportNow(),
  );
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const cloudDown = async () => new Response("down", { status: 503 });

type FetchMock = MockInstance<typeof fetch>;
function spyFetch(answer: (input: unknown) => Promise<Response>): FetchMock {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: unknown) => answer(input) as never);
}

const bootEnv = () => ({
  EDGE_MODE: "true",
  EDGE_CLOUD_URL: CLOUD_LINK_URL,
  EDGE_NODE_CREDENTIAL: node.credential,
  EDGE_NODE_ROLE: "standby",
});

type Handle = { stop(): Promise<void> };
const handles: Handle[] = [];
async function boot(
  overrides: Record<string, string | undefined> = {},
): Promise<Handle> {
  const handle = (await startEdgeRuntime({
    ...bootEnv(),
    ...overrides,
  })) as unknown as Handle;
  handles.push(handle);
  return handle;
}

/** Edge whose registry replica is `ageMs` old, with the cloud unreachable. */
async function bootStale(
  ageMs: number,
  overrides: Record<string, string | undefined> = {},
  cloud: (input: unknown) => Promise<Response> = cloudDown,
) {
  await saveDeviceRegistryCheckpoint(edgeScope(), node.id, {
    watermark: null,
    succeededAt: new Date(Date.now() - ageMs),
  });
  spyFetch(cloud);
  const handle = await boot(overrides);
  await vi.waitFor(() => expect(getDeviceRegistrySyncState()).toBeTruthy());
  return handle;
}

const edgeApp = createApp({ edgeMode: true });
const cloudApp = createApp();
const cloudState = getEdgeRuntimeState();

function heartbeat(app: ReturnType<typeof createApp>, token: string) {
  const path =
    app === edgeApp ? "/api/edge/devices/heartbeat" : "/api/devices/heartbeat";
  return request(app)
    .post(path)
    .set(DEVICE_TOKEN_HEADER, token)
    .send({
      version: "1.0.0",
      capabilities: ["print"],
      occurredAt: new Date().toISOString(),
    });
}

let statusToken = "";
async function edgeStatus() {
  const res = await request(edgeApp)
    .get("/api/edge/status")
    .set(DEVICE_TOKEN_HEADER, statusToken);
  expect(res.status).toBe(200);
  return (res.body.data ?? res.body) as {
    deviceRegistry: {
      lastPulledAt: string | null;
      stale: boolean;
      hardStale: boolean;
      maxStaleSeconds: number;
    };
  };
}

const notificationsOfSupervisor = async () =>
  (
    await owner.query<{ title: string }>(
      "SELECT title FROM notifications WHERE user_id = $1",
      [supervisorUserId],
    )
  ).rows;

const clearNotifications = async () => {
  await owner.query(
    "DELETE FROM delivery_attempts WHERE notification_id IN (SELECT id FROM notifications WHERE user_id = $1)",
    [supervisorUserId],
  );
  await owner.query("DELETE FROM notifications WHERE user_id = $1", [
    supervisorUserId,
  ]);
  // The alert id is stable per outlet and day and the consumer dedupes on its
  // outbox row: without this, an earlier test's alert would hide the next one.
  await owner.query(
    "DELETE FROM notification_outbox WHERE outlet_id = $1 AND event_type = 'edge_device_registry.hard_stale'",
    [outletA],
  );
};

let restoreModifierRecipeFk: () => Promise<void>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  restoreModifierRecipeFk = await simulateEdgeModifierRecipeFk(owner);
  await asOwner(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji registri basi keras', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletA, `HS${outletA.slice(0, 8)}`.toUpperCase(), outlets[0].id],
  );
  const registered = await registerEdgeNode(cloudScope(), actor, {
    outletId: outletA,
    role: "standby",
    label: "Mini PC uji registri basi keras",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  statusToken = (await enroll("Layar status")).token;

  // A supervisor of this outlet: the recipient of the hard-stale alert.
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Supervisor HS', $2, true)`,
    [supervisorUserId, `hs-${supervisorUserId.slice(0, 8)}@example.test`],
  );
  await asOwner(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'outlet', $3, now() - interval '1 minute', $2
       FROM roles WHERE tenant_id = $1 AND is_template AND template_key = 'supervisor'`,
    [tenantId, supervisorUserId, outletA],
  );
});

beforeEach(async () => {
  await asOwner("DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1", [
    node.id,
  ]);
  await clearNotifications();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  try {
    await clearNotifications();
    await owner.query("DELETE FROM role_assignments WHERE user_id = $1", [
      supervisorUserId,
    ]);
    for (const sql of [
      "DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1",
      "DELETE FROM device_training_periods WHERE outlet_id = $1",
      "DELETE FROM devices WHERE outlet_id = $1",
      "DELETE FROM edge_nodes WHERE outlet_id = $1",
      "DELETE FROM outlets WHERE id = $1",
    ])
      await asOwner(sql, [outletA]);
    await owner.query('DELETE FROM "user" WHERE id = $1', [supervisorUserId]);
  } catch {
    // leave rows behind; harmless for other files
  }
  await restoreModifierRecipeFk();
  await owner.end();
});

describe("legend-2lgu config EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS", () => {
  const parse = (extra: Record<string, string> = {}) =>
    parseEdgeRuntimeConfig({ ...bootEnv(), ...extra }) as
      | { ok: true; config: { deviceRegistryMaxStaleMs: number } }
      | { ok: false; problems: string[] };

  it("legend-2lgu defaults to 72 hours", () => {
    const parsed = parse();
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.config.deviceRegistryMaxStaleMs).toBe(72 * HOUR);
  });

  it.each([
    ["3600", 1 * HOUR],
    ["86400", 24 * HOUR],
    ["2592000", 30 * 24 * HOUR],
  ])("legend-2lgu accepts %s seconds", (seconds, ms) => {
    const parsed = parse({ EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: seconds });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.deviceRegistryMaxStaleMs).toBe(ms);
  });

  it.each(["3599", "0", "-1", "2592001", "1.5", "abc", "7200.5"])(
    "legend-2lgu refuses %s (below 1 hour, above 30 days, or not an integer)",
    (value) => {
      const parsed = parse({ EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: value });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect(parsed.problems.join(" ")).toContain(
          "EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS",
        );
    },
  );

  it("legend-2lgu must be at least twice EDGE_DEVICE_SYNC_STALE_SECONDS", () => {
    const refused = parse({
      EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600",
      EDGE_DEVICE_SYNC_STALE_SECONDS: "2000",
    });
    expect(refused.ok).toBe(false);
    const exact = parse({
      EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600",
      EDGE_DEVICE_SYNC_STALE_SECONDS: "1800",
    });
    expect(exact.ok).toBe(true);
  });
});

describe("legend-2lgu runtime sync state and /api/edge/status", () => {
  it("legend-2lgu a replica older than the limit with the cloud down is hard stale", async () => {
    await bootStale(2 * 24 * HOUR, {
      EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600",
    });
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
    const { deviceRegistry } = await edgeStatus();
    expect(deviceRegistry).toMatchObject({
      stale: true,
      hardStale: true,
      maxStaleSeconds: 3600,
    });
  });

  it("legend-2lgu the same replica is soft stale only under the 72 hour default", async () => {
    await bootStale(2 * 24 * HOUR);
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(getDeviceRegistrySyncState()?.hardStale).toBe(false);
    const { deviceRegistry } = await edgeStatus();
    expect(deviceRegistry).toMatchObject({
      stale: true,
      hardStale: false,
      maxStaleSeconds: 72 * 3600,
    });
  });

  it("legend-2lgu a fresh edge that never pulled is not hard stale in its first minute", async () => {
    spyFetch(cloudDown);
    await boot({ EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600" });
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(getDeviceRegistrySyncState()?.hardStale).toBe(false);
    const { deviceRegistry } = await edgeStatus();
    expect(deviceRegistry).toMatchObject({ stale: true, hardStale: false });
  });

  it("legend-2lgu a successful pull clears hardStale on the status", async () => {
    await bootStale(
      2 * 24 * HOUR,
      { EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600" },
      cloudAnswer,
    );
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    const { deviceRegistry } = await edgeStatus();
    expect(deviceRegistry).toMatchObject({ stale: false, hardStale: false });
  });
});

describe("legend-2lgu a hard stale edge refuses new device sessions only", () => {
  // Enrolled BEFORE the edge goes hard stale (enrolling is itself refused after).
  let fresh: Awaited<ReturnType<typeof enroll>>;
  beforeEach(async () => {
    fresh = await enroll();
    await bootStale(2 * 24 * HOUR, {
      EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600",
    });
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
  });

  it("legend-2lgu a device that never sent a heartbeat gets 503 EDGE_DEVICE_REGISTRY_STALE with a clear message", async () => {
    const { device, token } = fresh;
    await setLastSeen(device.id, null);
    const res = await heartbeat(edgeApp, token);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
    expect(res.body.error.message).toBe(STALE_MESSAGE);
    // The refused heartbeat records nothing.
    expect(await lastSeenOf(device.id)).toBeNull();
  });

  it("legend-2lgu a device whose last heartbeat is older than 5 minutes is a new session and is refused", async () => {
    const { device, token } = fresh;
    const old = new Date(Date.now() - 10 * MIN);
    await setLastSeen(device.id, old);
    const res = await heartbeat(edgeApp, token);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
    expect((await lastSeenOf(device.id))?.getTime()).toBe(old.getTime());
  });

  it("legend-2lgu a device with a live heartbeat (within 5 minutes) keeps its running session", async () => {
    const { device, token } = fresh;
    await setLastSeen(device.id, new Date(Date.now() - 1 * MIN));
    const res = await heartbeat(edgeApp, token);
    expect(res.status).toBe(200);
    expect(res.body.data.deviceId).toBe(device.id);
  });

  it("legend-2lgu issuing a token or enrolling a device on a hard stale edge is refused the same way", async () => {
    const { device } = fresh;
    await expect(
      issueDeviceToken(edgeScope(), actor, { deviceId: device.id }),
    ).rejects.toThrow(/terlalu lama tidak diperbarui/);
    await expect(
      enrollDevice(edgeScope(), actor, {
        outletId: outletA,
        type: "pos",
        label: "Kasir baru",
        stationId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/terlalu lama tidak diperbarui/);
  });

  it("legend-2lgu the refusal raises one alert to the supervisor and is deduplicated", async () => {
    const { device, token } = fresh;
    await setLastSeen(device.id, null);
    expect((await heartbeat(edgeApp, token)).status).toBe(503);
    await vi.waitFor(async () =>
      expect((await notificationsOfSupervisor()).length).toBeGreaterThanOrEqual(
        1,
      ),
    );
    // Same outlet, same day: further refusals add nothing.
    expect((await heartbeat(edgeApp, token)).status).toBe(503);
    expect((await heartbeat(edgeApp, token)).status).toBe(503);
    expect(await notificationsOfSupervisor()).toHaveLength(1);
  });
});

describe("legend-2lgu no refusal when the replica is not hard stale, and never in the cloud", () => {
  it("legend-2lgu under the 72 hour default the same 2 day old replica still lets a new session in, with no alert", async () => {
    await bootStale(2 * 24 * HOUR);
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    const { device, token } = await enroll();
    await setLastSeen(device.id, null);
    expect((await heartbeat(edgeApp, token)).status).toBe(200);
    expect(await notificationsOfSupervisor()).toHaveLength(0);
  });

  it("legend-2lgu a pull that succeeds again lets new sessions in", async () => {
    await bootStale(
      2 * 24 * HOUR,
      { EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS: "3600" },
      cloudAnswer,
    );
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    const { device, token } = await enroll();
    await setLastSeen(device.id, null);
    expect((await heartbeat(edgeApp, token)).status).toBe(200);
  });

  it("legend-2lgu the cloud heartbeat is not affected", async () => {
    const { device, token } = await enroll();
    await setLastSeen(device.id, null);
    expect((await heartbeat(cloudApp, token)).status).toBe(200);
    expect(await notificationsOfSupervisor()).toHaveLength(0);
  });
});
