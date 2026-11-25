// Edge Wi-Fi routes, port and runtime wiring (bead legend-hsk, plan
// docs/briefs/sub-ws09-wifi-plan.md sections 5-7; PRD v1.7 §3 F5 + F25, FAC-11,
// FAC-13, TEN-01..03). The real Express app, Better Auth, the RBAC resolver and
// PostgreSQL; the agent behind the routes is a stub so these tests cover the
// HTTP boundary and the wiring, not the agent's grant logic (edge-wifi-agent).
//
// Staff sign up on the cloud app (sign-up is cloud only) and sign in on the
// edge app, the way staff sign in on a node (AUTH-06).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
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
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { WifiGrantView } from "@starter/shared/edge";
import { createApp } from "../app.ts";
import {
  EDGE_REQUIRED_TABLES,
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  startWifiAgent,
} from "../edge/runtime.ts";
import {
  installWifiAgent,
  installWifiEnforcement,
  wifiAgent,
  wifiEnforcement,
} from "../edge/wifi/port.ts";
import type { WifiAgent } from "../services/edge-wifi-agent.service.ts";
import {
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers.ts";
import {
  cloudSignIn,
  agent,
  originHeader,
  verifySessionMfa,
} from "./helpers.ts";

const MAC = "aa:bb:cc:dd:ee:ff";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const cloudApp = createApp({ edgeMode: false });
const edgeApp = createApp({ edgeMode: true });
const cloudState = getEdgeRuntimeState();

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

/** This process becomes the edge node of `outletId`. */
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

function view(overrides: Partial<WifiGrantView> = {}): WifiGrantView {
  return {
    id: randomUUID(),
    tenantId: seededTenantId,
    outletId: seededOutletA,
    wifiSessionId: randomUUID(),
    deviceTag: "1a2b3c4d",
    speedTier: "full",
    bandwidthKbps: 20_000,
    status: "active",
    authorizedAt: "2026-11-09T10:00:00.000Z",
    expiresAt: "2026-11-09T12:05:00.000Z",
    endedAt: null,
    endReason: null,
    ...overrides,
  } as WifiGrantView;
}

function stubAgent() {
  const stub = {
    applySession: vi.fn(async () => view()),
    endSession: vi.fn(async () => [view({ status: "revoked" })]),
    listLiveGrants: vi.fn(async () => [view()]),
    walledGarden: vi.fn(async () => ({
      hosts: ["order.cafe.test", "pay.doit.id"],
      version: "a".repeat(64),
    })),
    reconcile: vi.fn(async () => ({
      authorized: 0,
      downgraded: 0,
      renewed: 0,
      revoked: 0,
      failed: 0,
    })),
  };
  return stub as typeof stub & WifiAgent;
}

async function asOwner(text: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

const seededSessions: string[] = [];

/** A live grant row, the way the agent leaves one while a guest is online. */
async function seedGrant(outletId: string, wifiSessionId: string) {
  seededSessions.push(wifiSessionId);
  await asOwner(
    `INSERT INTO wifi_device_grants
       (tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
        speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds,
        status, renew_until, requested_at)
     VALUES ($1, $2, $3, $4, $5, 'full', 20000, 2000, 3600, 'pending',
             now() + interval '1 hour', now())`,
    [
      seededTenantId,
      outletId,
      wifiSessionId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      MAC,
    ],
  );
}

/** Staff of the node's outlet, signed in (cloud only) with MFA verified. */
async function edgeStaff(
  template: "owner" | "cashier",
  outletId: string = seededOutletA,
) {
  const staff = await staffWithRole(cloudApp, {
    template,
    scopeType: template === "owner" ? "tenant" : "outlet",
    scopeId: template === "owner" ? null : outletId,
  });
  const client = agent(edgeApp);
  client.set("Cookie", await cloudSignIn(staff.email));
  await verifySessionMfa(staff.email);
  return { client, userId: staff.userId };
}

const grantsPath = "/api/edge/wifi/grants";
const gardenPath = "/api/edge/wifi/walled-garden";
const revokePath = (id: string) => `/api/edge/wifi/sessions/${id}/revoke`;
const codeOf = (res: { body: { error?: { code?: string } } }) =>
  res.body.error?.code;

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
  installWifiAgent(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    if (seededSessions.length > 0)
      await asOwner(
        "DELETE FROM wifi_device_grants WHERE wifi_session_id = ANY($1::uuid[])",
        [seededSessions],
      );
  } catch {
    // Best effort: random session ids cannot collide with other files.
  }
  await owner.end();
});

describe("legend-hsk edge-only and fail-closed", () => {
  it("the cloud answers 404 EDGE_ONLY_ROUTE on every Wi-Fi path", async () => {
    for (const [method, path] of [
      ["get", grantsPath],
      ["get", gardenPath],
      ["post", revokePath(randomUUID())],
    ] as const) {
      const res = await request(cloudApp)[method](path).set(originHeader);
      expect(res.status, path).toBe(404);
      expect(codeOf(res), path).toBe("EDGE_ONLY_ROUTE");
    }
  });

  it("an edge request without a session is 401", async () => {
    actAsEdge();
    installWifiAgent(stubAgent());
    const res = await request(edgeApp).get(grantsPath);
    expect(res.status).toBe(401);
  });

  it("a signed-in cashier without device.registry.manage is 403 and the agent is never asked", async () => {
    actAsEdge();
    const stub = stubAgent();
    installWifiAgent(stub);
    const cashier = await edgeStaff("cashier");
    for (const res of [
      await cashier.client.get(grantsPath),
      await cashier.client.get(gardenPath),
      await cashier.client
        .post(revokePath(randomUUID()))
        .set(originHeader)
        .send({}),
    ]) {
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe("PERMISSION_DENIED");
    }
    expect(stub.listLiveGrants).not.toHaveBeenCalled();
    expect(stub.walledGarden).not.toHaveBeenCalled();
    expect(stub.endSession).not.toHaveBeenCalled();
  });

  it("an edge node with no agent answers 503 WIFI_AGENT_NOT_READY (fail closed)", async () => {
    actAsEdge();
    installWifiAgent(null);
    const manager = await edgeStaff("owner");
    for (const res of [
      await manager.client.get(grantsPath),
      await manager.client.get(gardenPath),
      await manager.client
        .post(revokePath(randomUUID()))
        .set(originHeader)
        .send({}),
    ]) {
      expect(res.status).toBe(503);
      expect(codeOf(res)).toBe("WIFI_AGENT_NOT_READY");
    }
  });

  it("the port default fails closed for the sessions services, and installing then clearing restores it", async () => {
    const input = {
      outletId: outletIdSchema.parse(seededOutletA),
      wifiSessionId: randomUUID(),
      controllerDeviceId: MAC,
      speedTier: "full",
      fullSpeedKbps: 20_000,
      baseSpeedKbps: 2_000,
      remainingSeconds: 3600,
      sessionEndsAt: "2026-11-09T12:00:00.000Z",
    } as const;
    const context = scopedTo(seededOutletA);
    await expect(
      wifiEnforcement().applySession(context, input),
    ).rejects.toMatchObject({ status: 503, code: "WIFI_AGENT_NOT_READY" });
    await expect(
      wifiEnforcement().endSession(context, {
        outletId: input.outletId,
        wifiSessionId: input.wifiSessionId,
        reason: "session_ended",
      }),
    ).rejects.toMatchObject({ status: 503, code: "WIFI_AGENT_NOT_READY" });
    expect(() => wifiAgent()).toThrow(
      expect.objectContaining({ code: "WIFI_AGENT_NOT_READY" }),
    );

    const stub = stubAgent();
    installWifiAgent(stub);
    await wifiEnforcement().applySession(context, input);
    expect(stub.applySession).toHaveBeenCalledOnce();
    expect(wifiAgent()).toBe(stub);

    installWifiAgent(null);
    await expect(
      wifiEnforcement().applySession(context, input),
    ).rejects.toMatchObject({ code: "WIFI_AGENT_NOT_READY" });

    // The narrow port alone also installs and clears.
    installWifiEnforcement(stub);
    await wifiEnforcement().applySession(context, input);
    installWifiEnforcement(null);
    await expect(
      wifiEnforcement().applySession(context, input),
    ).rejects.toMatchObject({ code: "WIFI_AGENT_NOT_READY" });
  });
});

describe("legend-hsk GET /api/edge/wifi/grants and /walled-garden", () => {
  it("lists the node outlet's live grants, no-store, from the node identity only", async () => {
    actAsEdge(seededOutletA);
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const res = await manager.client.get(grantsPath);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].outletId).toBe(seededOutletA);
    expect(JSON.stringify(res.body)).not.toContain(MAC);
    expect(Object.keys(res.body.data[0])).not.toContain("controllerDeviceId");
    expect(stub.listLiveGrants).toHaveBeenCalledOnce();
    const [context, outletId] = stub.listLiveGrants.mock
      .calls[0] as unknown as [ScopedTenantContext, string];
    expect(outletId).toBe(seededOutletA);
    expect(context.tenant.tenantId).toBe(seededTenantId);
  });

  it("an agent view that leaks a raw controller id is never sent (strict response)", async () => {
    actAsEdge();
    const stub = stubAgent();
    stub.listLiveGrants.mockResolvedValue([
      { ...view(), controllerDeviceId: MAC } as never,
    ]);
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const res = await manager.client.get(grantsPath);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(MAC);
  });

  it("a query key is refused 422: the outlet is never taken from the request", async () => {
    actAsEdge(seededOutletA);
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const res = await manager.client.get(
      `${grantsPath}?outletId=${seededOutletB}`,
    );
    expect(res.status).toBe(422);
    expect(stub.listLiveGrants).not.toHaveBeenCalled();
  });

  it("serves the walled garden as { hosts, version }", async () => {
    actAsEdge();
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const res = await manager.client.get(gardenPath);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(Object.keys(res.body.data).sort()).toEqual(["hosts", "version"]);
    expect(res.body.data.hosts).toEqual(["order.cafe.test", "pay.doit.id"]);
    expect(res.body.data.version).toMatch(/^[0-9a-f]{64}$/);
    expect(stub.walledGarden).toHaveBeenCalledOnce();
  });
});

describe("legend-hsk POST /api/edge/wifi/sessions/:wifiSessionId/revoke", () => {
  it("revokes a known session as staff_revoked and writes the audit row", async () => {
    actAsEdge(seededOutletA);
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const sessionId = randomUUID();
    await seedGrant(seededOutletA, sessionId);
    const res = await manager.client
      .post(revokePath(sessionId))
      .set(originHeader)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(MAC);
    expect(stub.endSession).toHaveBeenCalledOnce();
    const [, input] = stub.endSession.mock.calls[0] as unknown as [
      ScopedTenantContext,
      { outletId: string; wifiSessionId: string; reason: string },
    ];
    expect(input).toEqual({
      outletId: seededOutletA,
      wifiSessionId: sessionId,
      reason: "staff_revoked",
    });
    const { rows } = await owner.query<{ actor: string; outlet: string }>(
      `SELECT event->>'actorId' AS actor, event->>'outletId' AS outlet
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'wifi_grant.revoked'
          AND event->>'objectId' = $2`,
      [seededTenantId, sessionId],
    );
    expect(rows).toEqual([{ actor: manager.userId, outlet: seededOutletA }]);
  });

  it("an unknown session, and one that belongs to another outlet, are 404 and never reach the provider", async () => {
    actAsEdge(seededOutletA);
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const elsewhere = randomUUID();
    await seedGrant(seededOutletB, elsewhere);
    for (const id of [randomUUID(), elsewhere]) {
      const res = await manager.client
        .post(revokePath(id))
        .set(originHeader)
        .send({});
      expect(res.status, id).toBe(404);
    }
    expect(stub.endSession).not.toHaveBeenCalled();
  });

  it("a non-uuid id and an extra body key are refused 422", async () => {
    actAsEdge();
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const sessionId = randomUUID();
    await seedGrant(seededOutletA, sessionId);
    const badId = await manager.client
      .post(revokePath("not-a-uuid"))
      .set(originHeader)
      .send({});
    expect(badId.status).toBe(422);
    const extra = await manager.client
      .post(revokePath(sessionId))
      .set(originHeader)
      .send({ reason: "device_moved" });
    expect(extra.status).toBe(422);
    expect(stub.endSession).not.toHaveBeenCalled();
  });

  it("a cookie request from another origin is refused 403 FORBIDDEN_ORIGIN", async () => {
    actAsEdge();
    const stub = stubAgent();
    installWifiAgent(stub);
    const manager = await edgeStaff("owner");
    const res = await manager.client
      .post(revokePath(randomUUID()))
      .set("Origin", "https://evil.example")
      .send({});
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe("FORBIDDEN_ORIGIN");
    expect(stub.endSession).not.toHaveBeenCalled();
  });
});

describe("legend-hsk runtime wiring", () => {
  const handles: { stop(): Promise<void> }[] = [];
  const scopeOf = (outletId: string) => ({
    tenantId: seededTenantId,
    outletId: outletIdSchema.parse(outletId),
    edgeNodeId: randomUUID(),
  });
  async function start(
    options: Partial<Parameters<typeof startWifiAgent>[0]> & {
      outletId: string;
    },
  ) {
    const handle = await startWifiAgent({
      context: scopedTo(options.outletId),
      scope: scopeOf(options.outletId),
      role: "primary",
      intervalMs: 3_600_000,
      ...options,
    });
    if (handle) handles.push(handle);
    return handle;
  }
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  it("the edge requires the grants table at boot", () => {
    expect(EDGE_REQUIRED_TABLES).toContain("wifi_device_grants");
  });

  it("a standby node installs nothing", async () => {
    const stub = stubAgent();
    expect(
      await start({ outletId: randomUUID(), role: "standby", agent: stub }),
    ).toBeNull();
    expect(() => wifiAgent()).toThrow();
    await expect(
      wifiEnforcement().endSession(scopedTo(seededOutletA), {
        outletId: seededOutletA as never,
        wifiSessionId: randomUUID(),
        reason: "session_ended",
      }),
    ).rejects.toMatchObject({ code: "WIFI_AGENT_NOT_READY" });
  });

  it("a primary node installs the agent, reconciles on the timer, and stop() uninstalls and frees the outlet lock", async () => {
    const outletId = randomUUID();
    const stub = stubAgent();
    const first = await start({ outletId, agent: stub, intervalMs: 20 });
    expect(first).not.toBeNull();
    expect(wifiAgent()).toBe(stub);
    expect(wifiEnforcement()).toBe(stub);
    await vi.waitFor(() =>
      expect(stub.reconcile.mock.calls.length).toBeGreaterThan(1),
    );
    const [, reconciled] = stub.reconcile.mock.calls[0] as unknown as [
      ScopedTenantContext,
      string,
    ];
    expect(reconciled).toBe(outletId);

    // One owner per outlet: a second process on the same outlet stays off.
    const second = stubAgent();
    // It keeps retrying the lock (edge-wifi-runtime), so it hands back a handle.
    const waiting = await start({
      outletId,
      agent: second,
      retryDelayMs: () => 3_600_000,
    });
    expect(waiting).not.toBeNull();
    expect(wifiAgent()).toBe(stub);
    await waiting!.stop();

    await first!.stop();
    expect(() => wifiAgent()).toThrow();
    const calls = stub.reconcile.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stub.reconcile.mock.calls.length).toBe(calls);

    // The lock is free again.
    const again = await start({ outletId, agent: second });
    expect(again).not.toBeNull();
    expect(wifiAgent()).toBe(second);
  });

  it("a reconcile error is logged and the loop keeps running", async () => {
    const stub = stubAgent();
    stub.reconcile
      .mockRejectedValueOnce(
        Object.assign(new Error("secret vendor text"), { code: "BOOM" }),
      )
      .mockResolvedValue({
        authorized: 0,
        downgraded: 0,
        renewed: 0,
        revoked: 0,
        failed: 0,
      });
    await start({ outletId: randomUUID(), agent: stub, intervalMs: 20 });
    await vi.waitFor(() =>
      expect(stub.reconcile.mock.calls.length).toBeGreaterThan(2),
    );
  });

  it("production with no controller adapter registered installs nothing (503, never a simulator)", async () => {
    expect(
      await start({ outletId: randomUUID(), production: true }),
    ).toBeNull();
    expect(() => wifiAgent()).toThrow();
  });

  it("outside production the simulator-backed agent is installed on a primary", async () => {
    const handle = await start({ outletId: randomUUID(), production: false });
    expect(handle).not.toBeNull();
    expect(typeof wifiAgent().applySession).toBe("function");
  });
});
