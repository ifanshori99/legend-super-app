// Periodic device-registry pull on the edge (bead legend-2lp.7; PRD v1.7 §3 F5,
// EDG-02 replication "cloud wins", EDG-03 revocation). The edge pulls the
// cloud registry at boot and then on a timer, keeps its watermark in
// `edge_pull_checkpoints`, and reports staleness on /api/edge/status. Written
// from the brief's contracts (docs/plan brief-2lp7 sections A-C), not from the
// implementation.
//
// Cloud and edge share one test database, so the "cloud" is a fetch spy that
// answers `GET /api/edge-sync/device-records` from `listDeviceRecordsSince`.
// The edge copy is made by deleting the local rows first (`forgetLocally`).
//
// Assumptions (brief ambiguities):
//  - startEdgeRuntime accepts an env-like object as its first argument (the
//    "env source") and returns a handle with `stop()`. Boot is non-blocking:
//    the first pull is asserted with `vi.waitFor` (polling, no fixed sleeps).
//  - The timer interval cannot be waited out in a test (minimum 10 s), so the
//    "next pull carries since" and "failed pull" cases drive the puller with
//    `runOnce()`, wired exactly as the runtime wires it (real store, real
//    `pullDeviceRegistry`, real fetcher over the spy).
//  - "Stale after staleAfter" is proven through the restart rule in the brief:
//    `lastSuccessAt` initialises from the stored checkpoint, so a checkpoint
//    older than the stale window plus a failing cloud reads as stale.
//  - GET /api/edge/status answers `{ data: {...} }` or the bare object; both
//    are read. The staff-pin refusal is told from a PIN failure by comparing
//    with the response of the same request once the replica knows the device.
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
  decodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { createDeviceRegistryPuller } from "../edge/device-registry-puller.ts";
import { createDeviceRecordsFetcher } from "../edge/cloud-http.ts";
import {
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  startEdgeRuntime,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  DEVICE_SYNC_OVERLAP_MS,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import {
  loadDeviceRegistryCheckpoint,
  saveDeviceRegistryCheckpoint,
} from "../services/edge-device-sync-store.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { simulateEdgeModifierRecipeFk } from "./helpers/edge-database.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
// Own outlet (cloned from the fixture outlet in beforeAll), never a fixture
// outlet: edge-db.test.ts registers its own active primary node on the fixture
// outlets, and one outlet allows one active node per role. Sharing would make
// both files depend on run order (shared test DB, files may run in parallel).
const outletA: string = randomUUID();
const actor = randomUUID();

const CLOUD_LINK_URL = "wss://cloud.registry-pull.test/api/edge-link";
const RECORDS_PATH = "/api/edge-sync/device-records";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const cloudBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const edgeBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "device" });
const scoped = (
  base: ReturnType<typeof cloudBase>,
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(base, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
const cloudScope = (outletId: string) => scoped(cloudBase(), outletId);
const edgeScope = (outletId: string) => scoped(edgeBase(), outletId);

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

const rowOf = async (id: string) =>
  (await asOwner("SELECT * FROM devices WHERE id = $1", [id])).rows[0];

/** Drops the local row, the way a fresh edge node has no replica yet. */
async function forgetLocally(...ids: string[]) {
  await asOwner(
    "DELETE FROM device_training_periods WHERE device_id = ANY($1::uuid[])",
    [ids],
  );
  await asOwner("DELETE FROM devices WHERE id = ANY($1::uuid[])", [ids]);
}

async function enroll(label?: string) {
  return enrollDevice(cloudScope(outletA), actor, {
    outletId: outletA,
    type: "pos",
    label: label ?? `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
}

// Later than every row, no settle window: fresh rows are exported at once.
const exportNow = () => ({
  now: new Date(Date.now() + 10 * 60_000),
  settleMs: 0,
});

let node: { id: string; credential: string };

const nodeKey = () => ({
  tenantId,
  outletId: outletIdSchema.parse(outletA),
  edgeNodeId: node.id,
});

/** What the cloud endpoint answers, as a Response, for one fetch call. */
async function cloudAnswer(input: unknown): Promise<Response> {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url,
  );
  const since = url.searchParams.get("since");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const page = await listDeviceRecordsSince(
    nodeKey(),
    { since: since ?? undefined, limit },
    exportNow(),
  );
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type SyncRecord = Awaited<
  ReturnType<typeof listDeviceRecordsSince>
>["data"][number];

/** The cloud's export record for one device, read before the local row goes. */
async function exportedRecord(deviceId: string): Promise<SyncRecord> {
  let since: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const result = await listDeviceRecordsSince(
      nodeKey(),
      { since, limit: 100 },
      exportNow(),
    );
    const found = result.data.find(
      (r) => (r as { id: string }).id === deviceId,
    );
    if (found) return found;
    if (result.meta.nextCursor === null) break;
    since = result.meta.nextCursor;
  }
  throw new Error("device record not exported");
}

/** A cloud that serves exactly these records in one page. */
const cloudServing = (records: unknown[]) => async () =>
  new Response(
    JSON.stringify({
      data: records,
      meta: { limit: 100, nextCursor: null, watermark: null },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

type FetchMock = MockInstance<typeof fetch>;

/** Fetch calls that target the registry endpoint. */
const registryCalls = (spy: FetchMock) =>
  spy.mock.calls.filter(([input]) =>
    String(typeof input === "string" ? input : (input as Request).url).includes(
      RECORDS_PATH,
    ),
  );

const urlOf = (call: Parameters<typeof fetch>) =>
  new URL(
    typeof call[0] === "string"
      ? call[0]
      : call[0] instanceof URL
        ? call[0].href
        : (call[0] as Request).url,
  );

const headerOf = (call: Parameters<typeof fetch>, name: string) => {
  const headers = call[1]?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers))
    return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const found = Object.entries(headers as Record<string, string>).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1] ?? null;
};

/** Spy on fetch: registry calls are answered by `answer`, others fail loudly. */
function spyFetch(answer: (input: unknown) => Promise<Response>): FetchMock {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: unknown) => answer(input) as never);
}

/** The puller wired the way the runtime wires it (brief, section C). */
function wirePuller(
  fetchImpl: typeof fetch,
  overrides: { staleAfterMs?: number } = {},
) {
  const context = edgeScope(outletA);
  const fetcher = createDeviceRecordsFetcher({
    cloudUrl: CLOUD_LINK_URL,
    credential: node.credential,
    fetchImpl,
  });
  return createDeviceRegistryPuller({
    pull: (since, signal) =>
      pullDeviceRegistry({
        context,
        since,
        fetchPage: (s: string | null) => fetcher(s, signal),
      }),
    load: () => loadDeviceRegistryCheckpoint(context, node.id),
    save: (input) => saveDeviceRegistryCheckpoint(context, node.id, input),
    intervalMs: 60_000,
    staleAfterMs: overrides.staleAfterMs ?? 900_000,
    maxBackoffMs: 300_000,
  });
}

const checkpointRow = async () =>
  (
    await asOwner(
      "SELECT * FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = 'device_registry'",
      [node.id],
    )
  ).rows[0];

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
  expect(handle).toBeTruthy();
  handles.push(handle);
  return handle;
}

const cloudState = getEdgeRuntimeState();
const app = createApp({ edgeMode: true });

// Assumption: the edge status screen is read by an enrolled device, so the
// calls carry a device token (a bare request is refused with 401).
let statusToken = "";

async function edgeStatus() {
  const res = await request(app)
    .get("/api/edge/status")
    .set(DEVICE_TOKEN_HEADER, statusToken);
  expect(res.status).toBe(200);
  return (res.body.data ?? res.body) as {
    deviceRegistry: { lastPulledAt: string | null; stale: boolean };
  };
}

let restoreModifierRecipeFk: () => Promise<void>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // The shared test database is cloud-style; startEdgeRuntime refuses it with
  // modifiers_recipe_fk, so simulate an edge database.
  restoreModifierRecipeFk = await simulateEdgeModifierRecipeFk(owner);
  await asOwner(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji tarik registri', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletA, `RP${outletA.slice(0, 8)}`.toUpperCase(), outlets[0].id],
  );
  const registered = await registerEdgeNode(cloudScope(outletA), actor, {
    outletId: outletA,
    role: "standby",
    label: "Mini PC uji tarik registri",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  statusToken = (await enroll("Layar status")).token;
});

beforeEach(async () => {
  await asOwner("DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1", [
    node.id,
  ]);
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  // Remove everything on the private outlet so no other file sees leftovers
  // (outlet counts, active edge nodes). Best effort: a failed cleanup must not
  // hide a test failure, and the private outlet cannot collide anyway.
  try {
    for (const sql of [
      "DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1",
      "DELETE FROM device_training_periods WHERE outlet_id = $1",
      "DELETE FROM devices WHERE outlet_id = $1",
      "DELETE FROM edge_nodes WHERE outlet_id = $1",
      "DELETE FROM outlets WHERE id = $1",
    ])
      await asOwner(sql, [outletA]);
  } catch {
    // leave rows behind; harmless for other files, see above
  }
  await restoreModifierRecipeFk();
  await owner.end();
});

describe("EDG-02 the edge pulls the cloud device registry", () => {
  it.each([undefined, "   "])(
    "G5b P1 production boot without maintenance URL (%j) pulls at once with the edge credential, and stop() releases the puller",
    async (maintenanceUrl) => {
      const spy = spyFetch(cloudAnswer);
      const handle = await boot({
        NODE_ENV: "production",
        MAINTENANCE_DATABASE_URL: maintenanceUrl,
      });

      // No interval elapsed: the boot itself triggers the first pull.
      await vi.waitFor(() =>
        expect(registryCalls(spy).length).toBeGreaterThan(0),
      );
      const first = registryCalls(spy)[0]!;
      expect(urlOf(first).pathname).toBe(RECORDS_PATH);
      expect(urlOf(first).host).toBe("cloud.registry-pull.test");
      expect(urlOf(first).protocol).toBe("https:");
      expect(headerOf(first, "authorization")).toBe(
        `Bearer ${node.credential}`,
      );
      // Nothing stored yet: the first pull starts from the beginning.
      expect(urlOf(first).searchParams.get("since")).toBeNull();

      // The boot pull finishes and its watermark is stored.
      await vi.waitFor(async () => expect(await checkpointRow()).toBeDefined());

      // The timer itself (no pull after stop, in-flight pull aborted) is proven
      // with fake timers in edge/device-registry-puller.test.ts; here the
      // runtime must drop its puller on stop.
      expect(getDeviceRegistrySyncState()).not.toBeNull();
      await handle.stop();
      expect(getDeviceRegistrySyncState()).toBeNull();
      handles.length = 0;
    },
  );

  it("EDG-02 the watermark is stored after a successful pull and the next pull resumes from it, rewound by the overlap", async () => {
    await enroll("Tarik watermark");
    const spy = spyFetch(cloudAnswer);
    const puller = wirePuller(globalThis.fetch);

    expect(await checkpointRow()).toBeUndefined();
    expect(await puller.runOnce()).toBe(true);

    const stored = await checkpointRow();
    expect(stored).toBeDefined();
    expect(stored.tenant_id).toBe(tenantId);
    expect(stored.outlet_id).toBe(outletA);
    expect(stored.edge_node_id).toBe(node.id);
    expect(stored.stream).toBe("device_registry");
    expect(typeof stored.watermark).toBe("string");
    expect(stored.last_success_at).toBeInstanceOf(Date);
    // The first pull asked for everything.
    expect(urlOf(registryCalls(spy)[0]!).searchParams.get("since")).toBeNull();

    const callsBefore = registryCalls(spy).length;
    expect(await puller.runOnce()).toBe(true);
    const second = registryCalls(spy)[callsBefore]!;
    const since = urlOf(second).searchParams.get("since");
    expect(since).not.toBeNull();
    expect(since).not.toBe(stored.watermark);
    const storedVersion = Date.parse(String(decodeCursor(stored.watermark)[1]));
    const askedVersion = Date.parse(String(decodeCursor(since!)[1]));
    // 1 ms slack: the cursor keeps microseconds, JS dates keep milliseconds.
    expect(
      Math.abs(storedVersion - askedVersion - DEVICE_SYNC_OVERLAP_MS),
    ).toBeLessThanOrEqual(1);
  });

  it("EDG-02 a restart resumes from the stored watermark instead of starting over", async () => {
    await enroll("Tarik restart");
    const spy = spyFetch(cloudAnswer);
    expect(await wirePuller(globalThis.fetch).runOnce()).toBe(true);
    const stored = await checkpointRow();
    const callsBefore = registryCalls(spy).length;

    // A new process: a new puller that only knows the database.
    expect(await wirePuller(globalThis.fetch).runOnce()).toBe(true);
    const resumed = urlOf(registryCalls(spy)[callsBefore]!).searchParams.get(
      "since",
    );
    expect(resumed).not.toBeNull();
    expect(
      Math.abs(
        Date.parse(String(decodeCursor(stored.watermark)[1])) -
          Date.parse(String(decodeCursor(resumed!)[1])) -
          DEVICE_SYNC_OVERLAP_MS,
      ),
    ).toBeLessThanOrEqual(1);
  });

  it("EDG-02 a corrupt stored watermark is dropped: the runtime pulls from the start instead of failing forever", async () => {
    await enroll("Tarik cursor rusak");
    await saveDeviceRegistryCheckpoint(edgeScope(outletA), node.id, {
      watermark: "not-a-cursor",
      succeededAt: new Date(),
    });
    const spy = spyFetch(cloudAnswer);
    await boot();
    await vi.waitFor(
      async () =>
        expect((await checkpointRow())?.watermark).not.toBe("not-a-cursor"),
      { timeout: 10_000 },
    );
    // The edge refused its own cursor before asking the cloud.
    const calls = registryCalls(spy);
    expect(calls.length).toBe(1);
    expect(urlOf(calls[0]!).searchParams.get("since")).toBeNull();
    expect(getDeviceRegistrySyncState()?.consecutiveFailures).toBe(0);
  });

  it("EDG-02 a cloud 400 on the stored cursor is retried once from the start", async () => {
    await enroll("Tarik cursor ditolak");
    spyFetch(cloudAnswer);
    expect(await wirePuller(globalThis.fetch).runOnce()).toBe(true);
    vi.restoreAllMocks();

    // The cloud no longer accepts the stored cursor (say, a format change).
    const spy = spyFetch(async (input) =>
      urlOf([input as never]).searchParams.has("since")
        ? new Response("bad cursor", { status: 400 })
        : cloudAnswer(input),
    );
    await boot();
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    const sinceParams = registryCalls(spy).map((call) =>
      urlOf(call).searchParams.get("since"),
    );
    // The fake cloud refuses the stored cursor on EVERY request that carries it,
    // like a real cloud. The fetcher may resend the same page once without
    // `edgeInstance` (legend-zsdd fallback): that retry still carries the
    // stored cursor and is refused too. Only the recovery drops the cursor.
    const stored = sinceParams[0];
    expect(stored).not.toBeNull();
    const last = sinceParams.length - 1;
    expect(last).toBeGreaterThanOrEqual(1);
    for (const since of sinceParams.slice(0, last)) expect(since).toBe(stored);
    expect(sinceParams[last]).toBeNull();
    expect(getDeviceRegistrySyncState()?.consecutiveFailures).toBe(0);
  });

  it("EDG-02 a pull applies a cloud revocation to the replica", async () => {
    const { device } = await enroll("Tarik cabut");
    const active = (await exportedRecord(device.id)) as { updatedAt: string };
    await forgetLocally(device.id);
    spyFetch(cloudServing([active]));
    expect(await wirePuller(globalThis.fetch).runOnce()).toBe(true);
    expect(await rowOf(device.id)).toMatchObject({ status: "active" });

    const revokedAt = new Date(
      Date.parse(active.updatedAt) + 30_000,
    ).toISOString();
    vi.restoreAllMocks();
    spyFetch(
      cloudServing([
        { ...active, status: "revoked", revokedAt, updatedAt: revokedAt },
      ]),
    );
    expect(await wirePuller(globalThis.fetch).runOnce()).toBe(true);
    expect(await rowOf(device.id)).toMatchObject({ status: "revoked" });
  });
});

describe("EDG-02 a failed pull changes nothing", () => {
  async function seededReplica() {
    const { device } = await enroll("Replika aman");
    spyFetch(cloudAnswer);
    const puller = wirePuller(globalThis.fetch);
    expect(await puller.runOnce()).toBe(true);
    const checkpoint = await checkpointRow();
    const replica = await rowOf(device.id);
    expect(replica).toBeDefined();
    return { device, checkpoint, replica };
  }

  it("EDG-02 a 503 from the cloud keeps the replica rows and the stored checkpoint", async () => {
    const { device, checkpoint, replica } = await seededReplica();
    vi.restoreAllMocks();
    const spy = spyFetch(async () => new Response("down", { status: 503 }));
    const failing = wirePuller(globalThis.fetch);

    expect(await failing.runOnce()).toBe(false);
    expect(registryCalls(spy).length).toBeGreaterThan(0);
    expect(await checkpointRow()).toEqual(checkpoint);
    expect(await rowOf(device.id)).toEqual(replica);

    const state = failing.getState();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).not.toBeNull();
    expect(state.lastError).not.toContain(node.credential);
    // Seeded from the stored checkpoint: the earlier success is still known.
    expect(state.lastSuccessAt).toBe(
      (checkpoint.last_success_at as Date).toISOString(),
    );
  });

  it("EDG-02 a network failure keeps the replica rows and the stored checkpoint", async () => {
    const { device, checkpoint, replica } = await seededReplica();
    vi.restoreAllMocks();
    spyFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const failing = wirePuller(globalThis.fetch);

    expect(await failing.runOnce()).toBe(false);
    expect(await checkpointRow()).toEqual(checkpoint);
    expect(await rowOf(device.id)).toEqual(replica);
    expect(failing.getState().consecutiveFailures).toBe(1);
    expect(failing.getState().lastError).not.toContain(node.credential);
  });

  it("EDG-02 a failure never deletes replica rows, and a later success recovers", async () => {
    const { device } = await seededReplica();
    vi.restoreAllMocks();
    spyFetch(async () => new Response("down", { status: 503 }));
    const puller = wirePuller(globalThis.fetch);
    expect(await puller.runOnce()).toBe(false);
    expect(await puller.runOnce()).toBe(false);
    expect(puller.getState().consecutiveFailures).toBe(2);
    expect(await rowOf(device.id)).toBeDefined();

    vi.restoreAllMocks();
    spyFetch(cloudAnswer);
    const recovering = wirePuller(globalThis.fetch);
    expect(await recovering.runOnce()).toBe(true);
    expect(recovering.getState().consecutiveFailures).toBe(0);
    expect(recovering.getState().stale).toBe(false);
  });
});

describe("EDG-03 staleness is visible on /api/edge/status", () => {
  it("EDG-03 before any successful pull the replica is stale and lastPulledAt is empty", async () => {
    spyFetch(async () => new Response("down", { status: 503 }));
    await boot();
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    const status = await edgeStatus();
    // legend-zsdd: the status also carries the refused-sequence count (0, no
    // successful pull yet) and the time of the last pull that refused (null).
    expect(status.deviceRegistry).toEqual({
      lastPulledAt: null,
      stale: true,
      // legend-2lgu: never pulled, but only just booted: not hard stale; the
      // default limit is 72 hours.
      hardStale: false,
      maxStaleSeconds: 72 * 3600,
      receiptSequencesRefused: 0,
      receiptSequencesRefusedAt: null,
      receiptRunAlert: false,
      receiptRunAlertAt: null,
      receiptSequencesRetired: 0,
      receiptSequencesRetiredAt: null,
    });
  });

  it("EDG-03 right after a successful pull it is not stale and shows when it last pulled", async () => {
    spyFetch(cloudAnswer);
    const before = Date.now();
    await boot();
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    const { deviceRegistry } = await edgeStatus();
    expect(deviceRegistry.stale).toBe(false);
    expect(deviceRegistry.lastPulledAt).not.toBeNull();
    // Allow a little clock skew between the test and the database clock.
    expect(Date.parse(deviceRegistry.lastPulledAt!)).toBeGreaterThanOrEqual(
      before - 5_000,
    );
  });

  it("EDG-03 a restart with an old checkpoint and an unreachable cloud is stale and keeps the old lastPulledAt", async () => {
    // Default stale window is 15 minutes; two days is far outside any setting.
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await saveDeviceRegistryCheckpoint(edgeScope(outletA), node.id, {
      watermark: null,
      succeededAt: old,
    });
    spyFetch(async () => new Response("down", { status: 503 }));
    await boot();
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    const { deviceRegistry } = await edgeStatus();
    expect(deviceRegistry.stale).toBe(true);
    expect(deviceRegistry.lastPulledAt).toBe(old.toISOString());
  });

  it("EDG-03 an unreachable cloud does not make the edge unhealthy: it keeps serving", async () => {
    spyFetch(async () => new Response("down", { status: 503 }));
    await boot();
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    const health = await request(app).get("/api/edge/health");
    expect(health.status).toBe(200);
    expect((health.body.data ?? health.body).deviceRegistry).toEqual({
      stale: true,
    });
  });
});

describe("EDG-03 a cloud device token on the edge", () => {
  function heartbeat(token: string) {
    return request(app)
      .post("/api/edge/devices/heartbeat")
      .set(DEVICE_TOKEN_HEADER, token)
      .send({
        version: "1.0.0",
        capabilities: ["print"],
        occurredAt: new Date().toISOString(),
      });
  }
  const verifyPin = (token: string) =>
    request(app)
      .post("/api/staff-pins/verify")
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ userId: randomUUID(), pin: "000000" });

  it("EDG-03 is refused before the first pull and accepted after it", async () => {
    const { device, token } = await enroll("Token tarik pertama");
    // Cloud side of the stand-in: serve this one device from the shared DB,
    // then forget it locally so the edge replica starts empty.
    const record = await exportedRecord(device.id);
    await forgetLocally(device.id);

    // Boot with the cloud unreachable: replica empty, device unknown, refused.
    spyFetch(async () => new Response("down", { status: 503 }));
    const first = await boot();
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    const refusedBeat = await heartbeat(token);
    expect(refusedBeat.status).toBeGreaterThanOrEqual(400);
    expect(refusedBeat.status).toBeLessThan(500);
    const refusedPin = await verifyPin(token);
    expect([401, 404]).toContain(refusedPin.status);
    expect(await rowOf(device.id)).toBeUndefined();
    await first.stop();
    handles.length = 0;

    // The cloud answers on the next boot: the same token now works.
    vi.restoreAllMocks();
    spyFetch(cloudServing([record]));
    await boot();
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    expect(await rowOf(device.id)).toMatchObject({ status: "active" });
    const beat = await heartbeat(token);
    expect(beat.status).toBe(200);
    expect(beat.body.data.deviceId).toBe(device.id);
    // The PIN check now runs (random user, so it fails on the PIN, not on the
    // device): the answer is no longer the device refusal seen before.
    const pin = await verifyPin(token);
    // Compared without the per-request requestId.
    const outcome = (res: { status: number; body: unknown }) => {
      const error = (
        res.body as { error?: { code?: string; message?: string } }
      ).error;
      return [res.status, error?.code, error?.message];
    };
    expect(outcome(refusedPin)[1]).toBeDefined();
    expect(outcome(pin)).not.toEqual(outcome(refusedPin));
  });
});

describe("legend-6xcy the runtime runs the master sync loop", () => {
  const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";
  const MASTER_SYNC_INTERVAL_MS = 5 * 60_000;

  it("starts a 5 minute master sync loop, and stop() resolves while its fetch hangs", async () => {
    let hangingSignal: AbortSignal | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (!href.includes(MASTERS_PATH)) return cloudAnswer(input);
      // legend-2uqcd: masters calls made before the loop's timer exists (the
      // bootstrap's and the boot-time sync before the catalog) are answered, so
      // the boot sync does not hang until its 5 s timeout; only calls after the
      // loop started hang.
      const loopStarted = intervalSpy.mock.calls.some(
        ([, delay]) => delay === MASTER_SYNC_INTERVAL_MS,
      );
      if (!loopStarted) return cloudAnswer(input);
      hangingSignal = init?.signal ?? null;
      // Never answers; only an abort ends it, like a dead link.
      return new Promise<Response>((_resolve, reject) => {
        hangingSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as never);
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    const handle = await boot();

    // legend-2uqcd: the loop starts after the boot-time masters sync (not
    // awaited by boot), so its timer appears a moment after boot() returns.
    let masterTimer = -1;
    await vi.waitFor(
      () => {
        masterTimer = intervalSpy.mock.calls.findIndex(
          ([, delay]) => delay === MASTER_SYNC_INTERVAL_MS,
        );
        expect(masterTimer).toBeGreaterThanOrEqual(0);
      },
      { timeout: 5_000, interval: 25 },
    );
    // Fire the first tick by hand instead of waiting 5 minutes. The boot-time
    // bootstrap also hit the masters path (its own signal is already spent), and
    // the loop's start run (catalog only, legend-24318) may still be in flight,
    // which makes a tick a no-op: count only masters calls made from here on and
    // retry the tick until one starts.
    const tick = intervalSpy.mock.calls[masterTimer]![0] as () => void;
    const mastersCalls = () =>
      fetchSpy.mock.calls.filter(([input]) =>
        String(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url,
        ).includes(MASTERS_PATH),
      ).length;
    const before = mastersCalls();
    hangingSignal = null;
    await vi.waitFor(
      () => {
        tick();
        expect(mastersCalls()).toBeGreaterThan(before);
      },
      { timeout: 5_000, interval: 25 },
    );
    expect(hangingSignal).not.toBeNull();
    expect(hangingSignal!.aborted).toBe(false);

    const stopped = await Promise.race([
      handle.stop().then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);
    expect(stopped).toBe("stopped");
    expect(hangingSignal!.aborted).toBe(true);
  });
});
