// legend-91u09 (P1-1 of the second opinion on 935): the hard stale limit of the
// device registry replica on the edge must also guard POST
// /api/staff-pins/pos-session, not only enroll / token issue / heartbeat.
// Written from docs/briefs/946-edge-stale-so944-fix.md and the second-opinion
// finding 1 (usul test), not from the implementation. Setup pattern copied from
// edge-device-registry-hard-stale.test.ts (shared test database, "cloud" is a
// fetch spy, edge booted with startEdgeRuntime) and pos-acting-staff.test.ts
// (cookie + PIN + device token).
//
// Rule under test: on a hard stale edge, a device with NO running session
// (devices.last_seen_at null or older than 5 minutes) cannot start a cashier
// session: pos-session is refused and no pos_acting_staff row is written. A
// device whose session is running (heartbeat within 5 minutes) keeps working.
// A replica that is not hard stale refuses nothing.
//
// Assumptions (the brief leaves the exact answer open):
//  - The refusal is the same as the heartbeat one: 503 with error code
//    EDGE_DEVICE_REGISTRY_STALE ("aturan penerimaan satu tempat").
//  - "Running session" is read from devices.last_seen_at (window 5 minutes),
//    like the heartbeat rule; the tests set it directly.
//  - The browser session of the cashier is a cookie from the cloud sign-up;
//    the edge app reads the same database, so the cookie is replayed to it.
//  - A refused request does not touch devices.last_seen_at.
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
import {
  getDeviceRegistrySyncState,
  getEdgeRuntimeState,
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

const PASSWORD = "Test-password-123!";
const PIN = "582914";
const MIN = 60_000;
const HOUR = 3_600_000;
const CLOUD_LINK_URL = "wss://cloud.pos-session-stale.test/api/edge-link";

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
     VALUES ($1, $2, $3, 'pos', 'Kasir sesi basi', now() - interval '1 minute')`,
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
  tenant = await createIsolatedTenant(`psh-${randomUUID().slice(0, 6)}`);
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
    label: "Mini PC uji pos-session basi",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
});

beforeEach(async () => {
  await asOwner("DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1", [
    node.id,
  ]);
});

afterEach(async () => {
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

describe("legend-91u09 pos-session on a hard stale edge", () => {
  // The replica is 96 hours old and the cloud cannot be reached: hard stale
  // under the 72 hour default.
  beforeEach(async () => {
    await bootWithReplicaAge(96 * HOUR, cloudDown);
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.hardStale).toBe(true),
    );
  });

  it("legend-91u09 a device that never had a heartbeat cannot start a cashier session and no token is written", async () => {
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);
    const res = await startSession(deviceId);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error?.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
    expect(await actingRowsOf(deviceId)).toHaveLength(0);
    expect(await lastSeenOf(deviceId)).toBeNull();
  });

  it("legend-91u09 a device whose last heartbeat is 10 minutes old is not a running session and is refused", async () => {
    const deviceId = await newDevice();
    const old = new Date(Date.now() - 10 * MIN);
    await setLastSeen(deviceId, old);
    const res = await startSession(deviceId);
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body.error?.code).toBe("EDGE_DEVICE_REGISTRY_STALE");
    expect(await actingRowsOf(deviceId)).toHaveLength(0);
    expect((await lastSeenOf(deviceId))?.getTime()).toBe(old.getTime());
  });

  it("legend-91u09 a device with a running session (heartbeat 1 minute ago) can still start a cashier session", async () => {
    const deviceId = await newDevice();
    await setLastSeen(deviceId, new Date(Date.now() - 1 * MIN));
    const res = await startSession(deviceId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.token).toMatch(/^pas_/);
    expect(await actingRowsOf(deviceId)).toHaveLength(1);
  });
});

describe("legend-91u09 pos-session when the replica is not hard stale", () => {
  it("legend-91u09 a fresh replica lets a device without a running session start a cashier session", async () => {
    await bootWithReplicaAge(1 * MIN, cloudAnswer);
    await vi.waitFor(() =>
      expect(getDeviceRegistrySyncState()?.lastSuccessAt).toBeTruthy(),
    );
    expect(getDeviceRegistrySyncState()?.hardStale).toBe(false);
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);
    const res = await startSession(deviceId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.token).toMatch(/^pas_/);
    expect(await actingRowsOf(deviceId)).toHaveLength(1);
  });

  it("legend-91u09 a replica 2 days old (soft stale, under the 72 hour limit) still lets a new session in", async () => {
    await bootWithReplicaAge(48 * HOUR, cloudDown);
    await vi.waitFor(() =>
      expect(
        getDeviceRegistrySyncState()?.consecutiveFailures,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(getDeviceRegistrySyncState()?.hardStale).toBe(false);
    const deviceId = await newDevice();
    await setLastSeen(deviceId, null);
    const res = await startSession(deviceId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await actingRowsOf(deviceId)).toHaveLength(1);
  });
});
