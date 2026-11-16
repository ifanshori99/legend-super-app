// legend-eewxw (P1-2 of the second opinion on 935): while the edge has not yet
// loaded and judged its local registry checkpoint, the registry status is "not
// ready", which is NOT the same as "fresh". Written from
// docs/briefs/946-edge-stale-so944-fix.md and the second-opinion finding 2
// (usul test), not from the implementation. Setup pattern copied from
// edge-device-registry-hard-stale.test.ts (shared test database, "cloud" is a
// fetch spy, edge booted with startEdgeRuntime).
//
// Rules under test:
//  - Until the local checkpoint is loaded and judged, a new device session
//    (device with no heartbeat in the last 5 minutes) is held back: it is not
//    admitted and devices.last_seen_at is not written. No cloud connection is
//    needed to leave that state.
//  - After the checkpoint (96 hours old, cloud unreachable) is judged hard
//    stale, that device is still refused (503 EDGE_DEVICE_REGISTRY_STALE): the
//    window before the checkpoint loaded gave it no running session.
//  - Requests during the not-ready window never update last_seen_at, also not
//    those of a device whose session was already running.
//  - Green pairs: a fresh checkpoint admits a new device once loaded; a device
//    whose session was running before keeps working on a hard stale replica.
//
// How the window is made: the checkpoint load (loadDeviceRegistryCheckpoint of
// the sync store) is held on a promise the test releases. The runtime boot is
// therefore still in progress while HTTP requests reach the edge app.
//
// Assumptions (the brief leaves the answer shape open):
//  - A request during the not-ready window is either answered with an error
//    status (>= 400) or kept waiting; it is never answered 200. The test waits
//    1.5 s to see which; both are accepted.
//  - The refusal after the replica is judged hard stale is the same as the
//    heartbeat one of legend-2lgu: 503 EDGE_DEVICE_REGISTRY_STALE.
//  - "Running session" is devices.last_seen_at within 5 minutes, set by the
//    tests directly.
import { randomUUID } from "node:crypto";
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
} from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  startEdgeRuntime,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { saveDeviceRegistryCheckpoint } from "../services/edge-device-sync-store.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";
import type { IsolatedTenant } from "./floor-test-helpers.ts";
import { simulateEdgeModifierRecipeFk } from "./helpers/edge-database.ts";

// The held checkpoint load. `gate` is null when loads pass straight through.
const hold = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  started: 0,
}));
vi.mock("../services/edge-device-sync-store.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../services/edge-device-sync-store.ts")
    >();
  return {
    ...original,
    loadDeviceRegistryCheckpoint: async (
      ...args: Parameters<typeof original.loadDeviceRegistryCheckpoint>
    ) => {
      hold.started += 1;
      if (hold.gate) await hold.gate;
      return original.loadDeviceRegistryCheckpoint(...args);
    },
  };
});

const MIN = 60_000;
const HOUR = 3_600_000;
const CLOUD_LINK_URL = "wss://cloud.not-ready.test/api/edge-link";

let tenant: IsolatedTenant;
let node: { id: string; credential: string };
let restoreModifierRecipeFk: () => Promise<void>;
const actor = randomUUID();
const edgeApp = createApp({ edgeMode: true });
const cloudState = getEdgeRuntimeState();

const scoped = (source: "session" | "device"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

async function asOwner(text: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function newDevice(lastSeenAt: Date | null) {
  const id = randomUUID();
  await asOwner(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, last_seen_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir belum siap', now() - interval '1 minute', $4)`,
    [id, tenant.tenantId, tenant.outletId, lastSeenAt],
  );
  const token = signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: id,
  });
  return { id, token };
}

const lastSeenOf = async (deviceId: string) =>
  (await asOwner("SELECT last_seen_at FROM devices WHERE id = $1", [deviceId]))
    .rows[0]?.last_seen_at as Date | null;

function heartbeat(token: string) {
  return request(edgeApp)
    .post("/api/edge/devices/heartbeat")
    .set(DEVICE_TOKEN_HEADER, token)
    .send({
      version: "1.0.0",
      capabilities: ["print"],
      occurredAt: new Date().toISOString(),
    });
}

const delay = (ms: number) =>
  new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/** Answer of a request if it comes within `ms`; null when it is kept waiting. */
async function answerWithin<T>(pending: PromiseLike<T>, ms: number) {
  return Promise.race([Promise.resolve(pending), delay(ms)]);
}

type Handle = { stop(): Promise<void> };
let booting: Promise<Handle> | null = null;
let release: (() => void) | null = null;
const handles: Handle[] = [];

/**
 * Starts the edge with a checkpoint `ageMs` old and the cloud unreachable, and
 * holds the checkpoint load. Resolves once the runtime is in the not-ready
 * window (the load has started and is waiting).
 */
async function bootHeldAt(ageMs: number) {
  await saveDeviceRegistryCheckpoint(scoped("device"), node.id, {
    watermark: null,
    succeededAt: new Date(Date.now() - ageMs),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("down", { status: 503 }),
  );
  hold.started = 0;
  hold.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  booting = startEdgeRuntime({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: CLOUD_LINK_URL,
    EDGE_NODE_CREDENTIAL: node.credential,
    EDGE_NODE_ROLE: "standby",
  }) as unknown as Promise<Handle>;
  booting.catch(() => undefined);
  // If the load is never reached the hold did not work: fail here, loudly.
  await vi.waitFor(() => expect(hold.started).toBeGreaterThanOrEqual(1), {
    timeout: 10_000,
  });
}

/** Lets the held load finish and waits for the runtime to be up. */
async function finishBoot() {
  release?.();
  release = null;
  hold.gate = null;
  const handle = await booting!;
  handles.push(handle);
  await vi.waitFor(() => expect(getDeviceRegistrySyncState()).toBeTruthy());
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  restoreModifierRecipeFk = await simulateEdgeModifierRecipeFk(owner);
  tenant = await createIsolatedTenant(`nrd-${randomUUID().slice(0, 6)}`);
  const registered = await registerEdgeNode(scoped("session"), actor, {
    outletId: tenant.outletId,
    role: "standby",
    label: "Mini PC uji registri belum siap",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
});

beforeEach(async () => {
  await asOwner("DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1", [
    node.id,
  ]);
});

afterEach(async () => {
  // Never leave a boot hanging on the gate, also when a test failed early.
  release?.();
  release = null;
  hold.gate = null;
  if (booting) {
    const handle = await booting.catch(() => null);
    if (handle && !handles.includes(handle)) handles.push(handle);
    booting = null;
  }
  for (const handle of handles.splice(0)) await handle.stop();
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  try {
    for (const sql of [
      "DELETE FROM edge_pull_checkpoints WHERE tenant_id = $1",
      "DELETE FROM device_training_periods WHERE tenant_id = $1",
      "DELETE FROM devices WHERE tenant_id = $1",
      "DELETE FROM edge_nodes WHERE tenant_id = $1",
    ])
      await asOwner(sql, [tenant.tenantId]);
  } catch {
    // leave rows behind; harmless for other files
  }
  await restoreModifierRecipeFk();
  await owner.end();
});

describe("legend-eewxw registry status not ready is not fresh", () => {
  it("legend-eewxw a new device is held back before the checkpoint is judged, and the old checkpoint then refuses it for good", async () => {
    const { id, token } = await newDevice(null);
    await bootHeldAt(96 * HOUR);

    const pending = heartbeat(token);
    const early = await answerWithin(pending, 1_500);
    // Not admitted while the status is unknown: refused or still waiting.
    if (early) expect(early.status).toBeGreaterThanOrEqual(400);
    // Nothing recorded as proof of a running session.
    expect(await lastSeenOf(id)).toBeNull();

    // Checkpoint loaded: 96 hours old, cloud unreachable = hard stale.
    await finishBoot();
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
    await pending.then(
      () => undefined,
      () => undefined,
    );

    // The device never had a running session: refused, every time.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await heartbeat(token);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error?.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
    }
    expect(await lastSeenOf(id)).toBeNull();
  });

  it("legend-eewxw a request during the not-ready window does not advance last_seen_at of a device whose session was running", async () => {
    const before = new Date(Date.now() - 1 * MIN);
    const { id, token } = await newDevice(before);
    await bootHeldAt(96 * HOUR);

    const pending = heartbeat(token);
    // Whatever the answer (the brief only fixes that last_seen_at stays), the
    // window gives no new proof of life.
    await answerWithin(pending, 1_500);
    expect((await lastSeenOf(id))?.getTime()).toBe(before.getTime());

    await finishBoot();
    await pending.then(
      () => undefined,
      () => undefined,
    );
  });
});

describe("legend-eewxw green pairs: ready status behaves as before", () => {
  it("legend-eewxw with a fresh checkpoint a new device is admitted once the checkpoint is loaded, without the cloud", async () => {
    const { id, token } = await newDevice(null);
    await bootHeldAt(1 * MIN);
    await finishBoot();
    // The cloud stays unreachable: leaving "not ready" needs no cloud answer.
    await vi.waitFor(async () => {
      const res = await heartbeat(token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(await lastSeenOf(id)).not.toBeNull();
    expect(getDeviceRegistrySyncState()?.hardStale).toBe(false);
  });

  it("legend-eewxw a device whose session was already running keeps working on a hard stale replica after the checkpoint is loaded", async () => {
    const before = new Date(Date.now() - 1 * MIN);
    const { id, token } = await newDevice(before);
    await bootHeldAt(96 * HOUR);
    await finishBoot();
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
    const res = await heartbeat(token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await lastSeenOf(id))!.getTime()).toBeGreaterThan(before.getTime());
  });
});
