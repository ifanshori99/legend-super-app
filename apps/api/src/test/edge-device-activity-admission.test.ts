// legend-91u09, legend-eewxw (architect addition on 946): the device session
// admission rule must count ANY accepted device request as activity, not only
// heartbeats; not-ready and refused requests prove nothing. Written from
// docs/briefs/946-edge-stale-so944-fix.md ("Tambahan"), not from the
// implementation. Setup pattern copied from edge-pos-session-hard-stale.test.ts
// (pos-session = the non-heartbeat device request) and
// edge-device-registry-not-ready.test.ts (held checkpoint load).
//
// Rules under test:
//  (a) hard stale replica + a device that became active through a non-heartbeat
//      request (no heartbeat ever) is still admitted;
//  (b) hard stale replica + a device never active is refused 503
//      EDGE_DEVICE_REGISTRY_STALE and devices.last_seen_at stays null;
//  (c) a request that arrives while the registry status is not_ready does not
//      write last_seen_at;
//  (d) an edge process without node identity cannot judge its replica: it
//      refuses (or holds) a device without a running session, writes nothing;
//  (e) last_seen_at in the future (more than 60 s ahead) is not a running
//      session.
//
// Assumptions (the brief leaves the exact answer open):
//  - The non-heartbeat request is POST /api/staff-pins/pos-session (cookie + PIN
//    + device token); an accepted one answers 201 and records activity.
//  - Activity is recorded in devices.last_seen_at (throttled to 60 s, so the
//    test only checks "not null" after the first accepted request).
//  - Refusal is 503 with EDGE_DEVICE_REGISTRY_STALE on a stale replica. For
//    not_ready and missing identity the brief fixes no status code: any answer
//    >= 400 or a request kept waiting is accepted, but never 201.
//  - A running session in the not_ready window may be admitted or held; only
//    "last_seen_at is not written" is asserted.
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
import { setEdgeNodeForTests } from "../edge/mode.ts";
import {
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
  setDeviceRegistryReadyForTests,
  setEdgeRuntimeStateForTests,
  startEdgeRuntime,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { listDeviceRecordsSince } from "../services/edge-device-sync.ts";
import { saveDeviceRegistryCheckpoint } from "../services/edge-device-sync-store.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
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

const PASSWORD = "Test-password-123!";
const PIN = "582914";
const MIN = 60_000;
const HOUR = 3_600_000;
const CLOUD_LINK_URL = "wss://cloud.activity-admission.test/api/edge-link";

let tenant: IsolatedTenant;
let node: { id: string; credential: string };
// Derived while the process still acts as the cloud (an edge cannot derive it).
let outletPepper: { version: number; pepper: Buffer };
let restoreModifierRecipeFk: () => Promise<void>;
const actor = randomUUID();
const roleId = randomUUID();

type Member = { userId: string; cookie: string };
let sessionOwner: Member; // logged in on the till
let cashier: Member; // the staff member whose PIN is typed

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

/** A real account, a tenant role and the session cookie of a sign-up. */
async function member(label: string): Promise<Member> {
  const email = `test-${randomUUID()}@example.com`;
  const response = await request(createApp())
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: label, email, password: PASSWORD });
  if (response.status !== 200)
    throw new Error(`Sign-up failed with ${response.status}`);
  const userId = response.body.user.id as string;
  const cookie = (response.headers["set-cookie"] as unknown as string[])
    .map((line) => line.split(";")[0])
    .join("; ");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { userId, cookie };
}

async function newDevice(): Promise<string> {
  const id = randomUUID();
  await asOwner(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir aktivitas', now() - interval '1 minute')`,
    [id, tenant.tenantId, tenant.outletId],
  );
  return id;
}

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

/** Sets the device's newest heartbeat; null = never had one. */
const setLastSeen = (deviceId: string, at: Date | null) =>
  asOwner("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [deviceId, at]);

const lastSeenOf = async (deviceId: string) =>
  (await asOwner("SELECT last_seen_at FROM devices WHERE id = $1", [deviceId]))
    .rows[0]?.last_seen_at as Date | null;

const actingRowsOf = async (deviceId: string) =>
  (
    await asOwner(
      "SELECT id FROM pos_acting_staff WHERE tenant_id = $1 AND device_id = $2",
      [tenant.tenantId, deviceId],
    )
  ).rows;

function startSession(deviceId: string) {
  return request(edgeApp)
    .post("/api/staff-pins/pos-session")
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set("Cookie", sessionOwner.cookie)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: cashier.userId, pin: PIN });
}

/** A healthy cloud: answers the registry endpoint from the shared database. */
const nodeKey = () => ({
  tenantId: tenantIdSchema.parse(tenant.tenantId),
  outletId: outletIdSchema.parse(tenant.outletId),
  edgeNodeId: node.id,
});
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
    { now: new Date(Date.now() + 10 * MIN), settleMs: 0 },
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

type Handle = { stop(): Promise<void> };
const handles: Handle[] = [];
let booting: Promise<Handle> | null = null;
let release: (() => void) | null = null;

const delay = (ms: number) =>
  new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/** Answer of a request if it comes within `ms`; null when it is kept waiting. */
async function answerWithin<T>(pending: PromiseLike<T>, ms: number) {
  return Promise.race([Promise.resolve(pending), delay(ms)]);
}

/** Stops the running edge runtime (the next boot may have another age). */
async function stopEdge() {
  for (const handle of handles.splice(0)) await handle.stop();
}

/**
 * Starts the edge with a checkpoint `ageMs` old, cloud unreachable, and holds
 * the checkpoint load: the runtime is in the not-ready window until
 * finishBoot().
 */
async function bootHeldAt(ageMs: number) {
  await saveDeviceRegistryCheckpoint(scoped("device"), node.id, {
    watermark: null,
    succeededAt: new Date(Date.now() - ageMs),
  });
  spyFetch(cloudDown);
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
  await vi.waitFor(() => expect(hold.started).toBeGreaterThanOrEqual(1), {
    timeout: 10_000,
  });
  installEdgeStaffPinPeppers(tenant.tenantId, tenant.outletId, [outletPepper]);
}

async function finishBoot() {
  release?.();
  release = null;
  hold.gate = null;
  const handle = await booting!;
  handles.push(handle);
  await vi.waitFor(() => expect(getDeviceRegistrySyncState()).toBeTruthy());
}


/** Edge whose registry replica is `ageMs` old, answered by `cloud`. */
async function bootWithReplicaAge(
  ageMs: number,
  cloud: (input: unknown) => Promise<Response>,
) {
  await saveDeviceRegistryCheckpoint(scoped("device"), node.id, {
    watermark: null,
    succeededAt: new Date(Date.now() - ageMs),
  });
  spyFetch(cloud);
  const handle = (await startEdgeRuntime({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: CLOUD_LINK_URL,
    EDGE_NODE_CREDENTIAL: node.credential,
    EDGE_NODE_ROLE: "standby",
  })) as unknown as Handle;
  handles.push(handle);
  await vi.waitFor(() => expect(getDeviceRegistrySyncState()).toBeTruthy());
  // An edge never holds the root pepper: it verifies PINs with the outlet
  // pepper the cloud derived for it (same value the PIN above was hashed with).
  installEdgeStaffPinPeppers(tenant.tenantId, tenant.outletId, [outletPepper]);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // Same test seam as pos-acting-staff.test.ts: devices of this tenant belong
  // to its outlet (the pin service resolves a device token to an outlet).
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    if (tenantId !== tenant.tenantId) return null;
    const { rows } = await owner.query(
      "SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2",
      [deviceId, tenantId],
    );
    return rows.length > 0 ? tenant.outletId : null;
  });
  restoreModifierRecipeFk = await simulateEdgeModifierRecipeFk(owner);
  tenant = await createIsolatedTenant(`eda-${randomUUID().slice(0, 6)}`);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Sesi Basi', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ]),
    ],
  );
  outletPepper = {
    version: currentStaffPinPepperVersion(),
    pepper: staffPinPepper(tenant.tenantId, tenant.outletId),
  };
  sessionOwner = await member("Sesi Login");
  cashier = await member("Kasir B");
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    { outletId: tenant.outletId, userId: cashier.userId },
    { pin: PIN },
  );
  const registered = await registerEdgeNode(scoped("session"), actor, {
    outletId: tenant.outletId,
    role: "standby",
    label: "Mini PC uji aktivitas perangkat",
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
  setEdgeNodeForTests(null);
  setDeviceRegistryReadyForTests(null);
  for (const handle of handles.splice(0)) await handle.stop();
  resetEdgeStaffPinPeppers();
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  try {
    for (const sql of [
      "DELETE FROM pos_acting_staff WHERE tenant_id = $1",
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

describe("legend-91u09 hard stale replica admits by activity of any request", () => {
  it("legend-91u09 a device that became active through pos-session (no heartbeat ever) is still admitted once the replica is hard stale", async () => {
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);

    // Healthy replica: the first pos-session is accepted and counts as activity.
    await bootWithReplicaAge(1 * MIN, cloudAnswer);
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    const first = await startSession(deviceId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await lastSeenOf(deviceId)).not.toBeNull();

    // The replica goes hard stale; the device never sent a heartbeat.
    await stopEdge();
    resetEdgeStaffPinPeppers();
    setEdgeRuntimeStateForTests(cloudState);
    vi.restoreAllMocks();
    await bootWithReplicaAge(96 * HOUR, cloudDown);
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
    const second = await startSession(deviceId);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
  });

  it("legend-91u09 a device that was never active is refused 503 on a hard stale replica and last_seen_at stays null", async () => {
    await bootWithReplicaAge(96 * HOUR, cloudDown);
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await startSession(deviceId);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error?.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
    }
    expect(await actingRowsOf(deviceId)).toHaveLength(0);
    expect(await lastSeenOf(deviceId)).toBeNull();
  });

  it("legend-91u09 a last_seen_at in the future (10 minutes or 2 hours ahead) is not a running session and is refused", async () => {
    await bootWithReplicaAge(96 * HOUR, cloudDown);
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
    for (const ahead of [10 * MIN, 2 * HOUR]) {
      const deviceId = await newDevice();
      const future = new Date(Date.now() + ahead);
      await setLastSeen(deviceId, future);
      const res = await startSession(deviceId);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error?.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
      expect(await actingRowsOf(deviceId)).toHaveLength(0);
      expect((await lastSeenOf(deviceId))?.getTime()).toBe(future.getTime());
    }
  });
});

describe("legend-eewxw not_ready requests write no last_seen_at", () => {
  it("legend-eewxw a never-active device asking during the not-ready window is not admitted and last_seen_at stays null", async () => {
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);
    await bootHeldAt(96 * HOUR);

    const pending = startSession(deviceId);
    const early = await answerWithin(pending, 1_500);
    if (early) expect(early.status).toBeGreaterThanOrEqual(400);
    expect(await lastSeenOf(deviceId)).toBeNull();

    await finishBoot();
    await pending.then(
      () => undefined,
      () => undefined,
    );
    expect(await lastSeenOf(deviceId)).toBeNull();
  });

  it("legend-eewxw a device with a running session asking during the not-ready window does not get last_seen_at advanced", async () => {
    const before = new Date(Date.now() - 1 * MIN);
    const deviceId = await newDevice();
    await setLastSeen(deviceId, before);
    await bootHeldAt(96 * HOUR);

    const pending = startSession(deviceId);
    await answerWithin(pending, 1_500);
    expect((await lastSeenOf(deviceId))?.getTime()).toBe(before.getTime());

    await finishBoot();
    await pending.then(
      () => undefined,
      () => undefined,
    );
  });
});

describe("legend-eewxw edge process without node identity", () => {
  // EDGE_MODE on, a registry puller that would judge "fresh", but the runtime
  // holds no node identity: the replica cannot be judged, so it is not fresh.
  it("legend-eewxw a device without a running session is not admitted and nothing is written", async () => {
    setEdgeNodeForTests(() => true);
    setDeviceRegistryReadyForTests({});
    expect(getEdgeRuntimeState().identity).toBeNull();
    installEdgeStaffPinPeppers(tenant.tenantId, tenant.outletId, [
      outletPepper,
    ]);
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);

    const pending = startSession(deviceId);
    const answer = await answerWithin(pending, 3_000);
    if (answer) {
      expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(
        400,
      );
      expect(answer.status).not.toBe(201);
    }
    expect(await actingRowsOf(deviceId)).toHaveLength(0);
    expect(await lastSeenOf(deviceId)).toBeNull();
  });
});
