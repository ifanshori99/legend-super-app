// E2 (brief 1269, "Keputusan CTO untuk E2", bead legend-osqou.23): device and
// staff PIN login on the outlet edge. Written from the decisions, over HTTP
// where a route exists.
//
//  1. The edge holds only the SHA-256 of the device token (never a key that
//     could sign one): a token is accepted by that digest alone.
//  3. POST /api/edge/staff-session (404 on the cloud): device token + staff PIN
//     make a session bound to that device, 12 h at most, ended by a revocation.
//     The cloud refuses the session; the edge refuses every other session.
//  4. The session carries only the listed operational permissions the role
//     really holds; everything that needs a second factor is refused.
//  5. Past 72 h without a people/PIN/device sync: no login and no override; a
//     running session keeps working.
//
// "Cloud" and "edge" share one test database: `asEdge` / `asCloud` switch the
// process role.
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  deviceSyncRecordSchema,
  EDGE_STAFF_SESSION_PERMISSIONS,
} from "@starter/shared/edge";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_HEADER } from "@starter/shared/pos/acting-staff";
import { createApp } from "../app.ts";
import { setCatalogOverrideClock } from "../edge/catalog-override.ts";
import {
  createDeviceRegistryPuller,
  type DeviceRegistryPullerDeps,
} from "../edge/device-registry-puller.ts";
import { withTokenHashRepull } from "../edge/device-token-hash-repull.ts";
import { createPeopleSnapshotPuller } from "../edge/people-snapshot-pull.ts";
import { setEdgeNodeForTests } from "../edge/mode.ts";
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
import { edgeSessionPermissions } from "../lib/edge-session.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { enrollDevice, issueDeviceToken } from "../services/device.service.ts";
import {
  applyDeviceRecords,
  listDeviceRecordsSince,
} from "../services/edge-device-sync.ts";
import {
  flushEdgeIdentityStamps,
  saveDeviceRegistryCheckpoint,
  saveEdgePullCheckpoint,
  saveStaffPinCheckpoint,
} from "../services/edge-device-sync-store.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { resolveKdsStaffConnection } from "../services/kds-realtime-auth.ts";
import { attemptApproverPin } from "../services/staff-pin-proof.service.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { originHeader } from "./helpers.ts";

// Real unless a test replaces it.
vi.mock("../lib/edge-session.ts", async (original) => {
  const real = await original<typeof import("../lib/edge-session.ts")>();
  return {
    ...real,
    edgeSessionPermissions: vi.fn(real.edgeSessionPermissions),
  };
});

const PASSWORD = "Test-password-123!";
const PIN = "582914";
const HOUR = 3_600_000;
const LOGIN = "/api/edge/staff-session";
const CLOUD_URL = "wss://cloud.invalid/api/edge-link";

let tenant: IsolatedTenant;
let node: { id: string; credential: string };
let outletPepper: { version: number; pepper: Buffer };
const actor = randomUUID();
const roleId = randomUUID();
const approverRoleId = randomUUID();
const cloudState = getEdgeRuntimeState();
const edgeApp = createApp({ edgeMode: true });
const cloudApp = createApp();

type Member = { userId: string; cookie: string };
let cashier: Member;
let supervisor: Member;
/** Holds `pos.void.approve` and `pos.refund.approve`; `supervisor` does not. */
let approver: Member;

const tenantOf = (source: "session" | "device") =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source,
  });
const scoped = (source: "session" | "device") =>
  establishScopedTenantContext(tenantOf(source), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(tenant.outletId)],
  });
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

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

/** A real account with the test role, its PIN at the outlet and a password cookie. */
async function member(label: string, role = roleId): Promise<Member> {
  const response = await request(cloudApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({
      name: label,
      email: `test-${randomUUID()}@example.com`,
      password: PASSWORD,
    });
  if (response.status !== 200)
    throw new Error(`Sign-up failed with ${response.status}`);
  const userId = response.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, role],
  );
  await resetPin(userId, PIN);
  return { userId, cookie: cookieOf(response) };
}

const resetPin = (userId: string, pin: string) =>
  setStaffPin(
    tenantOf("session"),
    userId,
    { outletId: tenant.outletId, userId },
    { pin },
  );

function cookieOf(response: request.Response): string {
  const lines = response.headers["set-cookie"] as unknown as
    string[] | undefined;
  return (lines ?? []).map((line) => line.split(";")[0]).join("; ");
}

let clockNow: () => Date = () => new Date();

function asCloud() {
  setEdgeNodeForTests(null);
  setEdgeRuntimeStateForTests(cloudState);
  setDeviceRegistryReadyForTests(null);
  setCatalogOverrideClock(null);
  resetEdgeStaffPinPeppers();
}

function asEdge() {
  setEdgeNodeForTests(() => true);
  setEdgeRuntimeStateForTests({
    ...cloudState,
    edgeMode: true,
    identity: {
      context: scoped("device"),
      scope: {
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        edgeNodeId: node.id,
      },
    },
  });
  setDeviceRegistryReadyForTests({});
  clockNow = () => new Date();
  setCatalogOverrideClock(() => clockNow());
  installEdgeStaffPinPeppers(tenant.tenantId, tenant.outletId, [outletPepper]);
}

type SyncStream = "device_registry" | "staff_pins" | "people";
async function syncedAt(stream: SyncStream, at: Date) {
  await saveEdgePullCheckpoint(
    scoped("device"),
    node.id,
    `catalog:identity:${stream}`,
    { watermark: null, succeededAt: at },
  );
}
async function syncedNow() {
  for (const stream of ["device_registry", "staff_pins", "people"] as const)
    await syncedAt(stream, new Date());
}

type TestDevice = { id: string; token: string };
let enrolledAt = 0;
async function newDevice(
  type: "pos" | "kds" | "waiter_phone" | "display" = "pos",
): Promise<TestDevice> {
  asCloud();
  // A different issue second per device keeps the tokens apart.
  enrolledAt -= 1;
  const result = await enrollDevice(
    scoped("session"),
    actor,
    {
      outletId: tenant.outletId,
      type,
      label: `E2 ${type}`,
      idempotencyKey: randomUUID(),
    },
    new Date(Date.now() - 60_000 + enrolledAt * 1000),
  );
  return { id: result.device.id, token: result.token };
}

function login(
  device: Pick<TestDevice, "token"> | null,
  body: { userId: string; pin: string } = { userId: cashier.userId, pin: PIN },
) {
  const call = request(edgeApp)
    .post(LOGIN)
    .set({ Host: tenant.hostname })
    .set(originHeader);
  if (device) call.set(DEVICE_TOKEN_HEADER, device.token);
  return call.send(body);
}

async function loggedIn(device: TestDevice, member: Member = cashier) {
  asEdge();
  const response = await login(device, { userId: member.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return cookieOf(response);
}

function outletClock(token: string) {
  return request(edgeApp)
    .post("/api/hris/attendance/outlet-clock")
    .set({ Host: tenant.hostname })
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, token)
    .send({
      type: "in",
      occurredAt: new Date().toISOString(),
      photoUploadRef: null,
      idempotencyKey: `att-e2-${randomUUID()}`,
    });
}

function expectRefused(
  response: request.Response,
  status: number,
  code: string,
) {
  expect(
    { status: response.status, code: response.body.error?.code },
    JSON.stringify(response.body),
  ).toEqual({ status, code });
}

function board(
  cookie: string | null,
  token: string | null,
  app: typeof edgeApp = edgeApp,
) {
  const call = request(app)
    .get(`/api/outlets/${tenant.outletId}/floor`)
    .set({ Host: tenant.hostname });
  if (cookie) call.set("Cookie", cookie);
  if (token) call.set(DEVICE_TOKEN_HEADER, token);
  return call;
}

const edgeSessionsOf = async (deviceId: string) =>
  (
    await owner.query(
      `SELECT id, user_id, auth_method, kind, tenant_id, mfa_verified_at,
              expires_at, created_at
         FROM session WHERE edge_device_id = $1`,
      [deviceId],
    )
  ).rows;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    if (tenantId !== tenant.tenantId) return null;
    const { rows } = await owner.query(
      "SELECT outlet_id FROM devices WHERE id = $1 AND tenant_id = $2",
      [deviceId, tenantId],
    );
    return (rows[0]?.outlet_id as string | undefined) ?? null;
  });
  tenant = await createIsolatedTenant(`e2p-${randomUUID().slice(0, 6)}`);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'E2 Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "floor.table.view",
        "kds.ticket.process",
        // Held by the role but outside the edge list.
        "floor.table.manage",
        "device.registry.manage",
        "pos.refund.request",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'E2 Penyetuju', false, NULL, $3, false, '["tenant"]')`,
    [
      approverRoleId,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "floor.table.view",
        "pos.void.approve",
        "pos.refund.approve",
        "pos.refund.request",
      ]),
    ],
  );
  outletPepper = {
    version: currentStaffPinPepperVersion(),
    pepper: staffPinPepper(tenant.tenantId, tenant.outletId),
  };
  cashier = await member("E2 Kasir");
  supervisor = await member("E2 Supervisor");
  approver = await member("E2 Penyetuju", approverRoleId);
  const registered = await registerEdgeNode(scoped("session"), actor, {
    outletId: tenant.outletId,
    role: "primary",
    label: "Mini PC E2",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
});

beforeEach(async () => {
  asCloud();
  await resetPin(cashier.userId, PIN);
  await resetPin(approver.userId, PIN);
  await syncedNow();
});

afterAll(() => {
  asCloud();
  setEdgeNodeForTests(null);
  setAuditWriter(null);
  setDeviceOutletResolver(null);
});

describe("device token digest (decision 1)", () => {
  const storedHash = async (id: string) =>
    (await asOwner("SELECT token_hash FROM devices WHERE id = $1", [id]))
      .rows[0]?.token_hash as string | null;

  it("stores the SHA-256 of the whole token at enroll and reissue, never in a response", async () => {
    asCloud();
    const enrolled = await enrollDevice(scoped("session"), actor, {
      outletId: tenant.outletId,
      type: "pos",
      label: "E2 digest",
      idempotencyKey: randomUUID(),
    });
    expect(await storedHash(enrolled.device.id)).toBe(sha256(enrolled.token));
    expect(JSON.stringify(enrolled.device)).not.toContain(
      sha256(enrolled.token),
    );
    const reissued = await issueDeviceToken(scoped("session"), actor, {
      deviceId: enrolled.device.id,
    });
    expect(reissued.token).not.toBe(enrolled.token);
    expect(await storedHash(enrolled.device.id)).toBe(sha256(reissued.token));
    expect(JSON.stringify(reissued.device)).not.toContain("okenHash");
    const { rows } = await asOwner(
      "SELECT event FROM audit_logs WHERE event->>'objectId' = $1",
      [enrolled.device.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(sha256(enrolled.token));
    expect(JSON.stringify(rows)).not.toContain(sha256(reissued.token));
  });

  it("accepts a token by its digest alone, whatever key signed it", async () => {
    const device = await newDevice();
    // The cloud's key is not the edge's key: swap the signature part, as a
    // token signed with another secret would look on the edge.
    const [prefix, body] = device.token.split(".");
    const foreign = `${prefix}.${body}.${createHmac(
      "sha256",
      "kunci cloud lain",
    )
      .update(`${prefix}.${body}`)
      .digest("base64url")}`;
    await asOwner("UPDATE devices SET token_hash = $2 WHERE id = $1", [
      device.id,
      sha256(foreign),
    ]);
    asEdge();
    expect((await login({ token: foreign })).status).toBe(201);
    // Validly signed with this process's own key, but not the stored digest.
    expect((await login(device)).status).toBe(401);
  });

  it("refuses a validly signed token the edge has no digest for", async () => {
    const device = await newDevice();
    await asOwner("UPDATE devices SET token_hash = NULL WHERE id = $1", [
      device.id,
    ]);
    asEdge();
    expectRefused(await login(device), 503, "EDGE_DEVICE_NOT_SYNCED");
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("refuses a token made with the edge's own secret (a stolen edge cannot forge)", async () => {
    const device = await newDevice();
    const forged = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId: device.id,
    });
    asEdge();
    // Newer than the digest on record: a reissue this edge has not pulled yet.
    expectRefused(
      await login({ token: forged }),
      503,
      "EDGE_DEVICE_NOT_SYNCED",
    );
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("refuses a rotated-out token", async () => {
    const device = await newDevice();
    const next = await issueDeviceToken(scoped("session"), actor, {
      deviceId: device.id,
    });
    asEdge();
    expectRefused(await login(device), 401, "UNAUTHORIZED");
    expect((await login({ token: next.token })).status).toBe(201);
  });

  it("refuses a revoked device", async () => {
    const device = await newDevice();
    await asOwner(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [device.id],
    );
    asEdge();
    expectRefused(await login(device), 401, "UNAUTHORIZED");
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("refuses an expired payload by the trusted clock, and any token before the clock is ready", async () => {
    const device = await newDevice();
    asEdge();
    clockNow = () => new Date(Date.now() + 91 * 24 * HOUR);
    expectRefused(await login(device), 401, "UNAUTHORIZED");
    setCatalogOverrideClock(null);
    expectRefused(await login(device), 503, "EDGE_DEVICE_NOT_SYNCED");
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("refuses a device of another outlet or tenant", async () => {
    const device = await newDevice();
    const other = await createIsolatedTenant(`e2o-${randomUUID().slice(0, 6)}`);
    asEdge();
    setEdgeRuntimeStateForTests({
      ...getEdgeRuntimeState(),
      identity: {
        context: scoped("device"),
        scope: {
          tenantId: tenant.tenantId,
          outletId: other.outletId,
          edgeNodeId: node.id,
        },
      },
    });
    expectRefused(await login(device), 401, "UNAUTHORIZED");
    setEdgeRuntimeStateForTests({
      ...getEdgeRuntimeState(),
      identity: {
        context: scoped("device"),
        scope: {
          tenantId: other.tenantId,
          outletId: other.outletId,
          edgeNodeId: node.id,
        },
      },
    });
    expectRefused(await login(device), 403, "TENANT_MISMATCH");
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("only a revoked or rotated-out token is declared invalid; any other refusal keeps the client's token", async () => {
    const stranger = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId: randomUUID(),
    });
    const device = await newDevice();
    const swapped = await newDevice();
    await asOwner("UPDATE devices SET token_hash = $2 WHERE id = $1", [
      swapped.id,
      sha256("token lain"),
    ]);
    const revoked = await newDevice();
    await asOwner(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [revoked.id],
    );
    const rotated = await newDevice();
    await issueDeviceToken(scoped("session"), actor, { deviceId: rotated.id });
    asEdge();
    // Not synced yet, or the wrong digest: the client keeps its token.
    expectRefused(await outletClock(stranger), 401, "UNAUTHORIZED");
    expectRefused(await outletClock(swapped.token), 401, "UNAUTHORIZED");
    // A trusted clock that jumped ahead says "expired" to every token.
    clockNow = () => new Date(Date.now() + 91 * 24 * HOUR);
    expectRefused(await outletClock(device.token), 401, "UNAUTHORIZED");
    clockNow = () => new Date();
    expectRefused(
      await outletClock(revoked.token),
      401,
      "DEVICE_TOKEN_INVALID",
    );
    expectRefused(
      await outletClock(rotated.token),
      401,
      "DEVICE_TOKEN_INVALID",
    );
    const other = await createIsolatedTenant(`e2k-${randomUUID().slice(0, 6)}`);
    setEdgeRuntimeStateForTests({
      ...getEdgeRuntimeState(),
      identity: {
        context: scoped("device"),
        scope: {
          tenantId: tenant.tenantId,
          outletId: other.outletId,
          edgeNodeId: node.id,
        },
      },
    });
    expectRefused(await outletClock(device.token), 401, "UNAUTHORIZED");
  });

  it("pulls the registry from the start once per boot while an active device has no digest", async () => {
    asCloud();
    const device = await newDevice();
    await asOwner(
      "UPDATE devices SET token_hash = $2 WHERE tenant_id = $1 AND token_hash IS NULL",
      [tenant.tenantId, sha256("x")],
    );
    asEdge();
    const missing = async () =>
      (await request(edgeApp).get("/api/edge/health")).body
        .devicesWithoutTokenHash;
    const boot = () => {
      const since: (string | null)[] = [];
      let fail = true;
      const puller = createDeviceRegistryPuller({
        pull: withTokenHashRepull(
          scoped("device"),
          tenant.outletId,
          async (from) => {
            since.push(from);
            if (from === null && fail) {
              fail = false;
              throw new Error("cloud down");
            }
            return { watermark: "w1" };
          },
        ),
        load: async () => ({ watermark: "w0", lastSuccessAt: null }),
        save: async () => undefined,
        intervalMs: HOUR,
        staleAfterMs: HOUR,
        maxBackoffMs: HOUR,
      });
      return { since, puller };
    };
    const clean = boot();
    await clean.puller.runOnce();
    await clean.puller.stop();
    expect(clean.since).toEqual(["w0"]);
    expect(await missing()).toBe(0);

    await asOwner("UPDATE devices SET token_hash = NULL WHERE id = $1", [
      device.id,
    ]);
    expect(await missing()).toBe(1);
    const needed = boot();
    for (let i = 0; i < 4; i += 1) await needed.puller.runOnce();
    await needed.puller.stop();
    // The failed attempt does not count; after the first success no more.
    expect(needed.since).toEqual([null, null, "w1", "w1"]);
  });

  it("goes out on the outlet's device stream only when the edge asks", async () => {
    const device = await newDevice();
    const key = {
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      outletId: outletIdSchema.parse(tenant.outletId),
      edgeNodeId: node.id,
    };
    const when = { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 };
    const plain = await listDeviceRecordsSince(key, { limit: 100 }, when);
    expect(JSON.stringify(plain)).not.toContain(sha256(device.token));
    const asked = await listDeviceRecordsSince(
      key,
      { limit: 100, deviceTokenHashes: "1" },
      when,
    );
    expect(
      asked.data.find((record) => record.id === device.id)?.tokenHash,
    ).toBe(sha256(device.token));
    const other = await createIsolatedTenant(`e2s-${randomUUID().slice(0, 6)}`);
    const foreign = await listDeviceRecordsSince(
      {
        tenantId: tenantIdSchema.parse(other.tenantId),
        outletId: outletIdSchema.parse(other.outletId),
        edgeNodeId: randomUUID(),
      },
      { limit: 100, deviceTokenHashes: "1" },
      when,
    );
    expect(JSON.stringify(foreign)).not.toContain(sha256(device.token));
  });

  it("apply keeps the digest of the newest token, and a revocation ends the device's sessions", async () => {
    const device = await newDevice();
    const when = { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 };
    const record = async () =>
      deviceSyncRecordSchema.parse(
        (
          await listDeviceRecordsSince(
            {
              tenantId: tenantIdSchema.parse(tenant.tenantId),
              outletId: outletIdSchema.parse(tenant.outletId),
              edgeNodeId: node.id,
            },
            { limit: 100, deviceTokenHashes: "1" },
            when,
          )
        ).data.find((row) => row.id === device.id),
      );
    const first = await record();
    await issueDeviceToken(scoped("session"), actor, { deviceId: device.id });
    const second = await record();
    expect(second.tokenHash).not.toBe(first.tokenHash);
    // An older record replayed late never brings the old digest back.
    await applyDeviceRecords(scoped("device"), [first]);
    expect(await storedHash(device.id)).toBe(second.tokenHash);
    // Same floor without the field (an older cloud): the digest stays.
    const withoutHash = { ...second };
    delete withoutHash.tokenHash;
    await applyDeviceRecords(scoped("device"), [withoutHash]);
    expect(await storedHash(device.id)).toBe(second.tokenHash);
    // A newer floor without the field: the old digest must not survive it.
    await applyDeviceRecords(scoped("device"), [
      {
        ...withoutHash,
        tokenIssuedAt: new Date(
          Date.parse(second.tokenIssuedAt!) + 5000,
        ).toISOString(),
      },
    ]);
    expect(await storedHash(device.id)).toBeNull();

    const running = await newDevice();
    const cookie = await loggedIn(running);
    expect((await board(cookie, running.token)).status).toBe(200);
    const [row] = (
      await asOwner("SELECT updated_at FROM devices WHERE id = $1", [
        running.id,
      ])
    ).rows;
    await applyDeviceRecords(scoped("device"), [
      deviceSyncRecordSchema.parse({
        ...first,
        id: running.id,
        status: "revoked",
        revokedAt: new Date().toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
      }),
    ]);
    expect(await edgeSessionsOf(running.id)).toHaveLength(0);
    expect((await board(cookie, running.token)).status).toBe(401);
  });
});

describe("staff PIN login on the edge (decision 3)", () => {
  it("does not exist on the cloud", async () => {
    const device = await newDevice();
    asCloud();
    const response = await request(cloudApp)
      .post(LOGIN)
      .set({ Host: tenant.hostname })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ userId: cashier.userId, pin: PIN });
    expect(response.status).toBe(404);
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("opens a session bound to the device, 12 h at most, without a second factor", async () => {
    const device = await newDevice();
    asEdge();
    const before = Date.now();
    const response = await login(device);
    expect(response.status).toBe(201);
    expect(response.body.data.staff.id).toBe(cashier.userId);
    expect(response.body.data.outletId).toBe(tenant.outletId);
    expect(JSON.stringify(response.body)).not.toContain(device.token);
    const rows = await edgeSessionsOf(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: cashier.userId,
      auth_method: "edge_staff_pin",
      kind: "customer",
      tenant_id: tenant.tenantId,
      mfa_verified_at: null,
    });
    const end = (rows[0].expires_at as Date).getTime();
    expect(end).toBeGreaterThan(before + 11 * HOUR);
    expect(end).toBeLessThanOrEqual(Date.now() + 12 * HOUR);
    const { rows: audits } = await asOwner(
      "SELECT event FROM audit_logs WHERE event->>'action' = 'edge_staff_session.started' AND event->>'objectId' = $1",
      [rows[0].id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].event).toMatchObject({
      actorId: cashier.userId,
      deviceId: device.id,
    });
    expect(JSON.stringify(audits)).not.toContain(PIN);
    expect(JSON.stringify(audits)).not.toContain(sha256(device.token));

    const cookie = cookieOf(response);
    expect((await board(cookie, device.token)).status).toBe(200);
  });

  it("needs a device token, and only a till, kitchen screen or waiter phone", async () => {
    const display = await newDevice("display");
    asEdge();
    expect((await login(null)).status).toBe(401);
    expect((await login(display)).status).toBe(403);
    for (const type of ["kds", "waiter_phone"] as const) {
      const device = await newDevice(type);
      asEdge();
      expect((await login(device)).status, type).toBe(201);
    }
  });

  it("needs a trusted origin and a strict body", async () => {
    const device = await newDevice();
    asEdge();
    const noOrigin = await request(edgeApp)
      .post(LOGIN)
      .set({ Host: tenant.hostname })
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ userId: cashier.userId, pin: PIN });
    expect(noOrigin.status).toBe(403);
    const extra = await login(device, {
      userId: cashier.userId,
      pin: PIN,
      deviceId: randomUUID(),
    } as never);
    expect(extra.status).toBe(422);
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("a session never works without its own device's token", async () => {
    const device = await newDevice();
    const other = await newDevice();
    const cookie = await loggedIn(device);
    expect((await board(cookie, null)).status).toBe(401);
    expect((await board(cookie, other.token)).status).toBe(401);
    expect((await board(cookie, device.token)).status).toBe(200);
  });

  it("ends when the device is revoked, when its token is rotated and after 12 h of trusted time", async () => {
    const device = await newDevice();
    const cookie = await loggedIn(device);
    clockNow = () => new Date(Date.now() + 12 * HOUR + 1000);
    expect((await board(cookie, device.token)).status).toBe(401);
    clockNow = () => new Date();
    expect((await board(cookie, device.token)).status).toBe(200);
    await asOwner(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [device.id],
    );
    expect((await board(cookie, device.token)).status).toBe(401);

    const rotated = await newDevice();
    const rotatedCookie = await loggedIn(rotated);
    asCloud();
    await issueDeviceToken(scoped("session"), actor, { deviceId: rotated.id });
    asEdge();
    expect((await board(rotatedCookie, rotated.token)).status).toBe(401);
  });

  it("a second login on the device replaces the first session", async () => {
    const device = await newDevice();
    const first = await loggedIn(device);
    const second = await loggedIn(device, supervisor);
    expect(await edgeSessionsOf(device.id)).toHaveLength(1);
    expect((await board(first, device.token)).status).toBe(401);
    expect((await board(second, device.token)).status).toBe(200);
  });

  it("a PIN reset ends the staff member's edge sessions", async () => {
    const device = await newDevice();
    const cookie = await loggedIn(device);
    asCloud();
    await resetPin(cashier.userId, "739105");
    asEdge();
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
    expect((await board(cookie, device.token)).status).toBe(401);
  });

  it("five wrong PINs lock the PIN, and the right PIN is refused after that", async () => {
    const device = await newDevice();
    asEdge();
    for (let attempt = 0; attempt < 4; attempt++) {
      const wrong = await login(device, {
        userId: cashier.userId,
        pin: "000001",
      });
      expect(wrong.status).toBe(401);
    }
    const fifth = await login(device, {
      userId: cashier.userId,
      pin: "000001",
    });
    expect(fifth.status).toBe(423);
    expect((await login(device)).status).toBe(423);
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });

  it("refuses a user who is not staff at the outlet, like a wrong PIN", async () => {
    const device = await newDevice();
    asEdge();
    const response = await login(device, { userId: randomUUID(), pin: PIN });
    expect(response.status).toBe(401);
    expect(await edgeSessionsOf(device.id)).toHaveLength(0);
  });
});

describe("sessions do not cross between edge and cloud (decision 3)", () => {
  it("the cloud refuses an edge_staff_pin session everywhere", async () => {
    const device = await newDevice();
    const cookie = await loggedIn(device);
    asCloud();
    expect((await board(cookie, device.token, cloudApp)).status).toBe(401);
    expect((await board(cookie, null, cloudApp)).status).toBe(401);
    const me = await request(cloudApp)
      .get("/api/auth/me")
      .set({ Host: tenant.hostname, Cookie: cookie });
    expect(me.status).toBe(401);
    const session = await request(cloudApp)
      .get("/api/auth/get-session")
      .set({ Cookie: cookie });
    expect(session.status).toBe(401);
  });

  it("the edge refuses a password session, also together with a valid device token", async () => {
    const device = await newDevice();
    asEdge();
    expect((await board(cashier.cookie, device.token)).status).toBe(401);
    expect((await board(cashier.cookie, null)).status).toBe(401);
    const session = await request(edgeApp)
      .get("/api/auth/get-session")
      .set({ Cookie: cashier.cookie });
    expect(session.status).toBe(401);
  });

  it("the edge opens no password session", async () => {
    asEdge();
    const { rows } = await owner.query<{ email: string }>(
      `SELECT email FROM "user" WHERE id = $1`,
      [cashier.userId],
    );
    const count = async () =>
      (
        await owner.query("SELECT 1 FROM session WHERE user_id = $1", [
          cashier.userId,
        ])
      ).rowCount;
    const before = await count();
    const response = await request(edgeApp)
      .post("/api/auth/sign-in/email")
      .set({ Host: tenant.hostname })
      .set(originHeader)
      .send({ email: rows[0]!.email, password: PASSWORD });
    expectRefused(response, 404, "CLOUD_ONLY_ROUTE");
    expect(response.headers["set-cookie"] ?? []).toEqual([]);
    expect(await count()).toBe(before);
  });

  it("the database keeps an edge_staff_pin session bound to a device and free of a second factor", async () => {
    const insert = (columns: string, values: string) =>
      owner.query(
        `INSERT INTO session (id, token, user_id, expires_at, auth_method${columns})
         VALUES ($1, $2, $3, now() + interval '1 hour', 'edge_staff_pin'${values})`,
        [randomUUID(), randomUUID(), cashier.userId],
      );
    await expect(insert("", "")).rejects.toThrow(
      "session_edge_staff_pin_check",
    );
    const device = `, '${randomUUID()}'`;
    await expect(
      insert(", edge_device_id, mfa_verified_at", `${device}, now()`),
    ).rejects.toThrow("session_edge_staff_pin_check");
    await expect(
      insert(", edge_device_id, kind", `${device}, 'management'`),
    ).rejects.toThrow("session_edge_staff_pin_check");
  });
});

describe("operational permissions only (decision 4)", () => {
  it("a listed permission the role holds works; a held but unlisted one is refused", async () => {
    const device = await newDevice();
    const cookie = await loggedIn(device);
    expect((await board(cookie, device.token)).status).toBe(200);
    const path = `/api/floor/zones/${randomUUID()}`;
    const manage = await request(edgeApp)
      .delete(path)
      .set({ Host: tenant.hostname, Cookie: cookie })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token);
    expect(manage.status).toBe(403);
    // The role does hold it: the same call with a password on the cloud passes
    // the permission check and ends at the unknown zone.
    asCloud();
    const cloud = await request(cloudApp)
      .delete(path)
      .set({ Host: tenant.hostname, Cookie: cashier.cookie })
      .set(originHeader);
    expect(cloud.status).toBe(404);
  });

  it("a listed permission the role does not hold is refused", async () => {
    const device = await newDevice("kds");
    const cookie = await loggedIn(device);
    const feed = await request(edgeApp)
      .get(`/api/outlets/${tenant.outletId}/expo`)
      .set({ Host: tenant.hostname, Cookie: cookie })
      .set(DEVICE_TOKEN_HEADER, device.token);
    expect(feed.status).toBe(403);
  });

  it("the list carries no override approval: those need the approver's own PIN", () => {
    expect(
      EDGE_STAFF_SESSION_PERMISSIONS.filter((code) =>
        /^pos\..*\.approve$/.test(code),
      ),
    ).toEqual([]);
  });

  it("the KDS socket cuts the role to the same list", async () => {
    const stationId = randomUUID();
    await asOwner(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Dapur E2', 'hot_kitchen')`,
      [stationId, tenant.tenantId, tenant.outletId],
    );
    const device = await newDevice("kds");
    const cookie = await loggedIn(device);
    const connect = () =>
      resolveKdsStaffConnection({
        url: `/api/outlets/${tenant.outletId}/kitchen/stations/${stationId}/realtime?after=0`,
        headers: {
          host: tenant.hostname,
          cookie,
          [DEVICE_TOKEN_HEADER.toLowerCase()]: device.token,
        },
      } as unknown as IncomingMessage);
    expect((await connect())?.userId).toBe(cashier.userId);
    vi.mocked(edgeSessionPermissions).mockImplementation(() => []);
    try {
      expect(await connect()).toBeNull();
    } finally {
      vi.mocked(edgeSessionPermissions).mockReset();
    }
  });

  it("the owner-only catalog override stays closed to a PIN session", async () => {
    const device = await newDevice();
    const cookie = await loggedIn(device);
    const response = await request(edgeApp)
      .post("/api/edge/catalog-override")
      .set({ Host: tenant.hostname, Cookie: cookie })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ minutes: 30, reason: "uji tanpa faktor kedua" });
    expect(response.status).toBe(403);
  });
});

describe("override approved with the PIN of the session's own user", () => {
  async function actingCashier(session: Member) {
    const device = await newDevice();
    const cookie = await loggedIn(device, session);
    const issued = await request(edgeApp)
      .post("/api/staff-pins/pos-session")
      .set({ Host: tenant.hostname, Cookie: cookie })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ userId: cashier.userId, pin: PIN });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    return { device, cookie, acting: issued.body.data.token as string };
  }

  function override(
    on: { device: TestDevice; cookie: string; acting: string | null },
    approverUserId: string,
    pin: string,
    objectId: string = randomUUID(),
    action: "void" | "refund" = "void",
  ) {
    const call = request(edgeApp)
      .post("/api/pos-overrides")
      .set({ Host: tenant.hostname, Cookie: on.cookie })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, on.device.token)
      .set("Idempotency-Key", randomUUID());
    if (on.acting) call.set(ACTING_STAFF_HEADER, on.acting);
    return call.send({
      outletId: tenant.outletId,
      action,
      valueIdr: 10_000,
      reason: "salah pesan",
      objectType: "pos_order",
      objectId,
      approval: { method: "supervisor_pin", approverUserId, pin },
    });
  }

  const recorded = async (objectId: string) =>
    (
      await asOwner("SELECT 1 FROM pos_overrides WHERE object_id = $1", [
        objectId,
      ])
    ).rowCount;

  it("the supervisor who opened the session approves the acting cashier", async () => {
    const on = await actingCashier(approver);
    const response = await override(on, approver.userId, PIN);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toMatchObject({
      status: "approved",
      requestedBy: cashier.userId,
      approvedBy: approver.userId,
    });
  });

  it("a wrong PIN is refused", async () => {
    const on = await actingCashier(approver);
    const objectId = randomUUID();
    const response = await override(on, approver.userId, "000001", objectId);
    expectRefused(response, 401, "PIN_INVALID");
    expect(await recorded(objectId)).toBe(0);
  });

  it("a session user whose role does not hold the approval is refused", async () => {
    const on = await actingCashier(supervisor);
    const objectId = randomUUID();
    const response = await override(on, supervisor.userId, PIN, objectId);
    expectRefused(response, 403, "PERMISSION_DENIED");
    expect(await recorded(objectId)).toBe(0);
  });

  it("the approver is never the requester, acting or not", async () => {
    const on = await actingCashier(approver);
    const objectId = randomUUID();
    expectRefused(
      await override(on, cashier.userId, PIN, objectId),
      403,
      "APPROVER_IS_REQUESTER",
    );
    expectRefused(
      await override({ ...on, acting: null }, approver.userId, PIN, objectId),
      403,
      "APPROVER_IS_REQUESTER",
    );
    expect(await recorded(objectId)).toBe(0);
  });

  /** The cashier's pending phone override whose chain `approver` approved, polled on the edge. */
  async function pollPhoneApproved(on: {
    device: TestDevice;
    cookie: string;
    acting: string;
  }) {
    const chainId = randomUUID();
    const overrideId = createUlid(Date.now());
    const orderId = randomUUID();
    await asOwner(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
          object_id, payload, requested_by, source, level, required_levels,
          required_steps, status, decided_by, decided_at, reason, request_reason,
          deadline_at, created_at)
       VALUES ($1, $2, $3, $1, 'pos_override', 'void', 'pos_override', $4, '{}', $5,
               'user', 1, 1, '[]'::jsonb, 'approved', $6, now(),
               'Disetujui lewat ponsel', 'salah pesan',
               now() + interval '1 hour', now() - interval '1 minute')`,
      [
        chainId,
        tenant.tenantId,
        tenant.outletId,
        overrideId,
        cashier.userId,
        approver.userId,
      ],
    );
    await asOwner(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, reason,
          value_idr, object_type, object_id, approval_request_id, request_fingerprint)
       VALUES ($1, $2, $3, 'void', 'supervisor_phone', 'pending', $4, 'salah pesan',
               10000, 'pos_order', $5, $6, $7)`,
      [
        ulidToUuid(overrideId),
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        orderId,
        chainId,
        "0".repeat(64),
      ],
    );
    const response = await request(edgeApp)
      .get(`/api/pos-overrides/${overrideId}`)
      .set({ Host: tenant.hostname, Cookie: on.cookie })
      .set(DEVICE_TOKEN_HEADER, on.device.token)
      .set(ACTING_STAFF_HEADER, on.acting);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.data;
  }

  it("without a PIN the session's own user approves nothing: a phone approval of theirs is rejected", async () => {
    expect(
      await pollPhoneApproved(await actingCashier(approver)),
    ).toMatchObject({ status: "rejected", approvedBy: null });
    // Another staff member's session: the approver's role is not cut.
    expect(
      await pollPhoneApproved(await actingCashier(supervisor)),
    ).toMatchObject({ status: "approved", approvedBy: approver.userId });
  });

  it("an approved refund override opens no refund on the edge", async () => {
    const on = await actingCashier(approver);
    const orderId = createUlid(Date.now());
    const approved = await override(
      on,
      approver.userId,
      PIN,
      orderId,
      "refund",
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const path = `/api/outlets/${tenant.outletId}/pos/orders/${orderId}/corrections/refund`;
    const body = {
      amountIdr: 10_000,
      reason: "wrong_order",
      reasonNote: "salah pesan",
      approvedBy: approver.userId,
      overrideId: approved.body.data.id as string,
      idempotencyKey: `refund-e2-${randomUUID()}`,
    };
    for (const acting of [on.acting, null]) {
      const call = request(edgeApp)
        .post(path)
        .set({ Host: tenant.hostname, Cookie: on.cookie })
        .set(originHeader)
        .set(DEVICE_TOKEN_HEADER, on.device.token);
      if (acting) call.set(ACTING_STAFF_HEADER, acting);
      const refused = await call.send(body);
      expectRefused(refused, 403, "PERMISSION_DENIED");
    }
    // Both roles hold pos.refund.request: on the cloud the call gets past it.
    asCloud();
    const cloud = await request(cloudApp)
      .post(path)
      .set({ Host: tenant.hostname, Cookie: cashier.cookie })
      .set(originHeader)
      .send(body);
    expectRefused(cloud, 404, "NOT_FOUND");
  });
});

describe("72 hours without a sync (decision 5)", () => {
  const realPuller = (save: DeviceRegistryPullerDeps["save"]) =>
    createDeviceRegistryPuller({
      pull: async () => ({ watermark: null }),
      load: async () => ({ watermark: null, lastSuccessAt: null }),
      save,
      intervalMs: HOUR,
      staleAfterMs: HOUR,
      maxBackoffMs: HOUR,
    });

  const streams: SyncStream[] = ["device_registry", "staff_pins", "people"];

  it.each(streams)(
    "refuses a new login when %s is older than 72 h",
    async (stream) => {
      const device = await newDevice();
      await syncedAt(stream, new Date(Date.now() - 72 * HOUR - 60_000));
      asEdge();
      const response = await login(device);
      expect(response.status).toBe(503);
      expect(await edgeSessionsOf(device.id)).toHaveLength(0);
      await syncedAt(stream, new Date(Date.now() - 71 * HOUR));
      expect((await login(device)).status).toBe(201);
    },
  );

  it("refuses a login when a sync never happened or lies in the future", async () => {
    const device = await newDevice();
    asEdge();
    await asOwner("DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1", [
      node.id,
    ]);
    expect((await login(device)).status).toBe(503);
    await syncedNow();
    await syncedAt("staff_pins", new Date(Date.now() + HOUR));
    expect((await login(device)).status).toBe(503);
  });

  it("measures with the trusted clock", async () => {
    const device = await newDevice();
    asEdge();
    clockNow = () => new Date(Date.now() + 73 * HOUR);
    expect((await login(device)).status).toBe(503);
  });

  // The pulls use the wall clock; a wall clock that jumped ahead and was set
  // back leaves the trusted clock ahead of it (monotonic since the jump).
  it("pulls that succeed keep the edge fresh after a wall clock jump of more than 72 h", async () => {
    const device = await newDevice();
    asEdge();
    clockNow = () => new Date(Date.now() + 100 * HOUR);
    expect((await login(device)).status).toBe(503);
    const pullers = [
      realPuller((input) =>
        saveDeviceRegistryCheckpoint(scoped("device"), node.id, input),
      ),
      realPuller((input) =>
        saveStaffPinCheckpoint(scoped("device"), node.id, input),
      ),
      createPeopleSnapshotPuller({
        config: { cloudUrl: CLOUD_URL, credential: node.credential },
        intervalMs: HOUR,
        staleAfterMs: HOUR,
        maxBackoffMs: HOUR,
        fetchImpl: async () => new Response(null, { status: 304 }),
        onError: (error) => {
          throw error;
        },
      }),
    ];
    for (const puller of pullers) {
      expect(await puller.runOnce()).toBe(true);
      await puller.stop();
    }
    expect((await login(device)).status).toBe(201);
  });

  it("a pull that finished before the trusted clock was installed counts once it is", async () => {
    const device = await newDevice();
    asEdge();
    await asOwner("DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1", [
      node.id,
    ]);
    setCatalogOverrideClock(null);
    await saveDeviceRegistryCheckpoint(scoped("device"), node.id, {
      watermark: null,
      succeededAt: new Date(),
    });
    asEdge();
    await syncedAt("staff_pins", new Date());
    await syncedAt("people", new Date());
    expect((await login(device)).status).toBe(503);
    await flushEdgeIdentityStamps();
    expect((await login(device)).status).toBe(201);
  });

  it("a running session keeps working, but no cashier switch and no override", async () => {
    const device = await newDevice();
    const cookie = await loggedIn(device);
    for (const stream of streams)
      await syncedAt(stream, new Date(Date.now() - 80 * HOUR));
    expect((await board(cookie, device.token)).status).toBe(200);
    const switched = await request(edgeApp)
      .post("/api/staff-pins/pos-session")
      .set({ Host: tenant.hostname, Cookie: cookie })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .send({ userId: supervisor.userId, pin: PIN });
    expect(switched.status).toBe(503);
    await expect(
      attemptApproverPin(tenantOf("session"), {
        outletId: tenant.outletId,
        approverUserId: supervisor.userId,
        requesterUserId: cashier.userId,
        pin: PIN,
        deviceId: device.id,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ status: 503 });
    await syncedNow();
    await expect(
      attemptApproverPin(tenantOf("session"), {
        outletId: tenant.outletId,
        approverUserId: supervisor.userId,
        requesterUserId: cashier.userId,
        pin: PIN,
        deviceId: device.id,
        now: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});
