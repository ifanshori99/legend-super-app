// Edge Wi-Fi agent against a real disposable PostgreSQL with the in-memory
// controller simulator and a fake clock (bead legend-hsk; PRD v1.7 §3 F5 +
// F25, FAC-11 walled garden, FAC-13 throttle never cut, TEN-01 isolation).
//
// Every test gets its own isolated tenant (one outlet): `reconcile` works on a
// whole outlet, so rows left by another test would change its counts.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ApplyWifiSessionInput } from "@starter/shared/edge";
import { WifiControllerSimulator } from "../edge/wifi/simulator.ts";
import {
  createWifiAgent,
  WIFI_BASE_CHUNK_SECONDS,
  WIFI_FULL_GRACE_SECONDS,
  WIFI_RENEW_LEAD_SECONDS,
} from "../services/edge-wifi-agent.service.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const FULL = 10_000;
const BASE = 1_000;
const tenantIds: string[] = [];

const ctxFor = (
  tenant: IsolatedTenant,
  outletIds: string[] = [tenant.outletId],
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
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

type Row = {
  id: string;
  status: string;
  speed_tier: string;
  bandwidth_kbps: number;
  controller_device_id: string | null;
  superseded_by: string | null;
  end_reason: string | null;
  revoke_requested_at: Date | null;
  attempt_count: number;
};

async function rowsOf(tenant: IsolatedTenant, wifiSessionId: string) {
  return asOwner(tenant.tenantId, async (client) => {
    const result = await client.query<Row>(
      `SELECT id, status, speed_tier, bandwidth_kbps, controller_device_id, superseded_by,
              end_reason, revoke_requested_at, attempt_count
       FROM wifi_device_grants
       WHERE tenant_id = $1 AND wifi_session_id = $2
       ORDER BY requested_at, created_at, id`,
      [tenant.tenantId, wifiSessionId],
    );
    return result.rows;
  });
}

const mac = () =>
  randomUUID().replace(/-/g, "").slice(0, 12).match(/../g)!.join(":");

/** One tenant, one simulator, one agent and a clock the test moves. */
async function fixture(options: { providerTimeoutMs?: number } = {}) {
  const tenant = await createIsolatedTenant(`wifi-${randomUUID().slice(0, 8)}`);
  tenantIds.push(tenant.tenantId);
  let clock = new Date("2026-11-09T02:00:00.000Z");
  const now = () => new Date(clock);
  const sim = new WifiControllerSimulator({ now });
  const ctx = ctxFor(tenant);
  const contexts = new Map<string, ScopedTenantContext>([
    [tenant.outletId, ctx],
  ]);
  const agent = createWifiAgent({
    provider: sim,
    contextFor: (outletId: OutletId) => {
      const found = contexts.get(outletId);
      if (!found) throw new Error("No node context for outlet");
      return found;
    },
    now,
    providerTimeoutMs: options.providerTimeoutMs ?? 2_000,
  });
  const outletId = outletIdSchema.parse(tenant.outletId);
  return {
    tenant,
    ctx,
    sim,
    agent,
    outletId,
    contexts,
    now,
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    input(
      overrides: Partial<ApplyWifiSessionInput> = {},
    ): ApplyWifiSessionInput {
      return {
        outletId,
        wifiSessionId: randomUUID(),
        controllerDeviceId: mac(),
        speedTier: "full",
        fullSpeedKbps: FULL,
        baseSpeedKbps: BASE,
        remainingSeconds: 3600,
        sessionEndsAt: new Date(clock.getTime() + 12 * 3600_000).toISOString(),
        ...overrides,
      };
    },
    access(deviceId: string) {
      return sim.deviceAccess(tenant.tenantId, tenant.outletId, deviceId);
    },
  };
}

afterAll(async () => {
  // Isolated tenants stay; give them a valid creator so the platform tenant
  // list still parses them.
  if (tenantIds.length > 0)
    await owner.query(
      "UPDATE tenants SET created_by = $2 WHERE id = ANY($1::uuid[])",
      [tenantIds, randomUUID()],
    );
  await owner.end();
});

describe("edge Wi-Fi agent (legend-hsk)", () => {
  it("first apply grants full speed for the remaining quota plus grace", async () => {
    const f = await fixture();
    const input = f.input();
    const view = await f.agent.applySession(f.ctx, input);
    expect(view).toMatchObject({
      status: "active",
      speedTier: "full",
      bandwidthKbps: FULL,
      wifiSessionId: input.wifiSessionId,
      endReason: null,
    });
    expect(new Date(view.expiresAt!).getTime()).toBe(
      f.now().getTime() + (3600 + WIFI_FULL_GRACE_SECONDS) * 1000,
    );
    expect(view.deviceTag).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(view)).not.toContain(input.controllerDeviceId);
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      bandwidthKbps: FULL,
      reference: view.id,
    });
    expect(f.sim.calls.authorize).toBe(1);
  });

  it("repeating the same apply makes no provider call", async () => {
    const f = await fixture();
    const input = f.input();
    const first = await f.agent.applySession(f.ctx, input);
    f.advance(5);
    const again = await f.agent.applySession(f.ctx, {
      ...input,
      remainingSeconds: 3595,
    });
    expect(again.id).toBe(first.id);
    expect(f.sim.calls.authorize).toBe(1);
    // The same device id in another spelling is the same device.
    const upper = await f.agent.applySession(f.ctx, {
      ...input,
      remainingSeconds: 3595,
      controllerDeviceId: input.controllerDeviceId.toUpperCase(),
    });
    expect(upper.id).toBe(first.id);
    expect(f.sim.calls.authorize).toBe(1);
  });

  it("a base apply is make-before-break: the old grant is superseded, never revoked, no cut", async () => {
    const f = await fixture();
    const input = f.input();
    const full = await f.agent.applySession(f.ctx, input);
    f.advance(60);
    const base = await f.agent.applySession(f.ctx, {
      ...input,
      remainingSeconds: 0,
    });
    expect(base.id).not.toBe(full.id);
    expect(base).toMatchObject({
      status: "active",
      speedTier: "base",
      bandwidthKbps: BASE,
    });
    expect(f.sim.calls.revoke).toBe(0);
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE,
      reference: base.id,
    });
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows.map((r) => [r.id, r.status, r.superseded_by])).toEqual([
      [full.id, "superseded", base.id],
      [base.id, "active", null],
    ]);
    expect(rows[0]!.controller_device_id).toBeNull();
    f.advance(4000);
    expect(f.sim.cuts()).toEqual([]);
  });

  it("FAC-13 the loop downgrades a full grant at quota end without kmd3, and never cuts", async () => {
    const f = await fixture();
    const input = f.input({ remainingSeconds: 600 });
    const full = await f.agent.applySession(f.ctx, input);
    f.advance(300);
    expect(await f.agent.reconcile(f.ctx, f.outletId)).toEqual({
      authorized: 0,
      downgraded: 0,
      renewed: 0,
      revoked: 0,
      failed: 0,
    });
    f.advance(300); // quota spent: expires_at - grace == now
    const tick = await f.agent.reconcile(f.ctx, f.outletId);
    expect(tick.downgraded).toBe(1);
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE,
    });
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows.map((r) => [r.status, r.speed_tier])).toEqual([
      ["superseded", "full"],
      ["active", "base"],
    ]);
    expect(rows[0]!.superseded_by).toBe(rows[1]!.id);
    expect(rows[0]!.id).toBe(full.id);
    f.advance(WIFI_FULL_GRACE_SECONDS + 60);
    expect(f.sim.cuts()).toEqual([]);
    expect(f.access(input.controllerDeviceId).state).toBe("online");
  });

  it("renews a base grant before it expires, while the session lasts", async () => {
    const f = await fixture();
    const input = f.input({ speedTier: "base", remainingSeconds: 0 });
    const base = await f.agent.applySession(f.ctx, input);
    const expires = new Date(base.expiresAt!).getTime();
    expect(expires - f.now().getTime()).toBe(
      (WIFI_BASE_CHUNK_SECONDS + WIFI_FULL_GRACE_SECONDS) * 1000,
    );
    f.advance(
      WIFI_BASE_CHUNK_SECONDS +
        WIFI_FULL_GRACE_SECONDS -
        WIFI_RENEW_LEAD_SECONDS,
    );
    const tick = await f.agent.reconcile(f.ctx, f.outletId);
    expect(tick.renewed).toBe(1);
    const access = f.access(input.controllerDeviceId);
    expect(access).toMatchObject({ state: "online", bandwidthKbps: BASE });
    expect(access.state === "online" && access.reference).not.toBe(base.id);
    // A second tick right after has nothing to renew.
    expect((await f.agent.reconcile(f.ctx, f.outletId)).renewed).toBe(0);
    f.advance(WIFI_RENEW_LEAD_SECONDS + 60);
    expect(f.sim.cuts()).toEqual([]);
  });

  it("renewal stops at renew_until; the loop then revokes with day_closed", async () => {
    const f = await fixture();
    const input = f.input({
      speedTier: "base",
      remainingSeconds: 0,
      sessionEndsAt: new Date(f.now().getTime() + 3600_000).toISOString(),
    });
    const base = await f.agent.applySession(f.ctx, input);
    // Grant runs to renew_until + grace: nothing to renew.
    expect(new Date(base.expiresAt!).getTime() - f.now().getTime()).toBe(
      (3600 + WIFI_FULL_GRACE_SECONDS) * 1000,
    );
    f.advance(3600 + WIFI_FULL_GRACE_SECONDS - WIFI_RENEW_LEAD_SECONDS);
    expect((await f.agent.reconcile(f.ctx, f.outletId)).renewed).toBe(0);
    f.advance(WIFI_RENEW_LEAD_SECONDS);
    const tick = await f.agent.reconcile(f.ctx, f.outletId);
    expect(tick).toMatchObject({ renewed: 0, revoked: 1 });
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows.map((r) => [r.status, r.end_reason])).toEqual([
      ["revoked", "day_closed"],
    ]);
    expect(rows[0]!.controller_device_id).toBeNull();
    expect(f.sim.calls.authorize).toBe(1);
  });

  it("a timeout leaves unknown; the loop re-authorizes the same reference (one effective grant)", async () => {
    const f = await fixture();
    const input = f.input();
    f.sim.script("authorize", "applied_then_timeout");
    const view = await f.agent.applySession(f.ctx, input);
    expect(view.status).toBe("unknown");
    // A repeat apply while in flight returns the same row, no new call.
    const again = await f.agent.applySession(f.ctx, input);
    expect(again.id).toBe(view.id);
    expect(f.sim.calls.authorize).toBe(1);
    // Too young for the loop.
    f.advance(5);
    expect((await f.agent.reconcile(f.ctx, f.outletId)).authorized).toBe(0);
    f.advance(6);
    expect((await f.agent.reconcile(f.ctx, f.outletId)).authorized).toBe(1);
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows.map((r) => [r.id, r.status])).toEqual([[view.id, "active"]]);
    expect(rows[0]!.attempt_count).toBe(2);
    expect(f.sim.calls.authorize).toBe(2);
    // The replay applied nothing new at the controller.
    expect(f.sim.requests.map((r) => r.reference)).toEqual([view.id]);
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      reference: view.id,
    });
  });

  it("an in-flight grant refuses a different request with 409", async () => {
    const f = await fixture();
    const input = f.input();
    f.sim.script("authorize", "timeout");
    expect((await f.agent.applySession(f.ctx, input)).status).toBe("unknown");
    await expect(
      f.agent.applySession(f.ctx, { ...input, remainingSeconds: 0 }),
    ).rejects.toMatchObject({ status: 409, code: "WIFI_GRANT_IN_FLIGHT" });
  });

  it("a refused authorize fails the new grant and leaves the old grant intact", async () => {
    const f = await fixture();
    const input = f.input();
    const full = await f.agent.applySession(f.ctx, input);
    f.advance(60);
    f.sim.script("authorize", "reject");
    await expect(
      f.agent.applySession(f.ctx, { ...input, remainingSeconds: 0 }),
    ).rejects.toMatchObject({ status: 502, code: "WIFI_AUTHORIZE_REFUSED" });
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows.map((r) => [r.status, r.speed_tier])).toEqual([
      ["active", "full"],
      ["failed", "base"],
    ]);
    expect(rows[1]!.controller_device_id).toBeNull();
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      bandwidthKbps: FULL,
      reference: full.id,
    });
  });

  it("a device bound to another live session answers 409", async () => {
    const f = await fixture();
    const input = f.input();
    await f.agent.applySession(f.ctx, input);
    await expect(
      f.agent.applySession(f.ctx, {
        ...input,
        wifiSessionId: randomUUID(),
        controllerDeviceId: ` ${input.controllerDeviceId.toUpperCase()} `,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "WIFI_DEVICE_BOUND_ELSEWHERE",
    });
    expect(f.sim.calls.authorize).toBe(1);
  });

  it("endSession revokes, records the reason and scrubs the device id", async () => {
    const f = await fixture();
    const input = f.input();
    await f.agent.applySession(f.ctx, input);
    const views = await f.agent.endSession(f.ctx, {
      outletId: f.outletId,
      wifiSessionId: input.wifiSessionId,
      reason: "session_ended",
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      status: "revoked",
      endReason: "session_ended",
    });
    expect(views[0]!.endedAt).not.toBeNull();
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows[0]!.controller_device_id).toBeNull();
    expect(f.access(input.controllerDeviceId).state).toBe("blocked");
    expect(f.sim.cuts()).toEqual([]);
    expect(await f.agent.listLiveGrants(f.ctx, f.outletId)).toEqual([]);
    // Ending again is a no-op that answers the same grants.
    const again = await f.agent.endSession(f.ctx, {
      outletId: f.outletId,
      wifiSessionId: input.wifiSessionId,
      reason: "staff_revoked",
    });
    expect(again.map((v) => v.endReason)).toEqual(["session_ended"]);
    expect(f.sim.calls.revoke).toBe(1);
  });

  it("a failed revoke is kept and retried by the loop", async () => {
    const f = await fixture();
    const input = f.input();
    await f.agent.applySession(f.ctx, input);
    f.sim.script("revoke", "transport_error");
    const views = await f.agent.endSession(f.ctx, {
      outletId: f.outletId,
      wifiSessionId: input.wifiSessionId,
      reason: "staff_revoked",
    });
    expect(views[0]).toMatchObject({
      status: "active",
      endReason: "staff_revoked",
    });
    expect(f.access(input.controllerDeviceId).state).toBe("online");
    // A new apply for an ending session is refused.
    await expect(f.agent.applySession(f.ctx, input)).rejects.toMatchObject({
      status: 409,
    });
    const tick = await f.agent.reconcile(f.ctx, f.outletId);
    expect(tick.revoked).toBe(1);
    const rows = await rowsOf(f.tenant, input.wifiSessionId);
    expect(rows.map((r) => [r.status, r.end_reason])).toEqual([
      ["revoked", "staff_revoked"],
    ]);
    expect(f.access(input.controllerDeviceId).state).toBe("blocked");
  });

  it("FAC-11 every authorize carries the built walled garden, and the loop syncs it", async () => {
    const f = await fixture();
    const garden = await f.agent.walledGarden(f.ctx);
    expect(garden.version).toMatch(/^[0-9a-f]{64}$/);
    expect(garden.hosts).toContain(f.tenant.hostname);
    expect(garden.hosts).toContain("pay.doit.id");
    expect(garden.hosts).toEqual([...garden.hosts].sort());
    const input = f.input({ remainingSeconds: 600 });
    await f.agent.applySession(f.ctx, input);
    f.advance(600);
    await f.agent.reconcile(f.ctx, f.outletId);
    expect(f.sim.requests).toHaveLength(2);
    for (const request of f.sim.requests)
      expect(request.walledGarden).toEqual(garden.hosts);
    expect(f.sim.calls.syncWalledGarden).toBe(1);
    expect(
      f.sim.canReach(f.tenant.tenantId, f.tenant.outletId, null, "pay.doit.id"),
    ).toBe(true);
    expect(
      f.sim.canReach(f.tenant.tenantId, f.tenant.outletId, null, "example.com"),
    ).toBe(false);
    // Unchanged list: no second sync.
    await f.agent.reconcile(f.ctx, f.outletId);
    expect(f.sim.calls.syncWalledGarden).toBe(1);
  });

  it("TEN-01 another tenant cannot see or end this tenant's sessions", async () => {
    const a = await fixture();
    const b = await fixture();
    const input = a.input();
    await a.agent.applySession(a.ctx, input);
    await expect(
      a.agent.listLiveGrants(b.ctx, a.outletId),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      a.agent.endSession(b.ctx, {
        outletId: a.outletId,
        wifiSessionId: input.wifiSessionId,
        reason: "staff_revoked",
      }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    // Its own outlet with tenant A's session id: not found.
    await expect(
      b.agent.endSession(b.ctx, {
        outletId: b.outletId,
        wifiSessionId: input.wifiSessionId,
        reason: "staff_revoked",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await b.agent.listLiveGrants(b.ctx, b.outletId)).toEqual([]);
    // A node context of another tenant is never used for tenant A calls.
    a.contexts.set(a.tenant.outletId, b.ctx);
    await expect(
      a.agent.endSession(a.ctx, {
        outletId: a.outletId,
        wifiSessionId: input.wifiSessionId,
        reason: "staff_revoked",
      }),
    ).resolves.toEqual([expect.objectContaining({ status: "active" })]);
    expect(a.access(input.controllerDeviceId).state).toBe("online");
    expect(await a.agent.listLiveGrants(a.ctx, a.outletId)).toHaveLength(1);
  });

  it("an outlet-scoped context of another outlet is refused", async () => {
    const f = await fixture();
    const other = ctxFor(f.tenant, [randomUUID()]);
    await expect(f.agent.applySession(other, f.input())).rejects.toMatchObject({
      code: "OUTLET_OUT_OF_SCOPE",
    });
    await expect(f.agent.reconcile(other, f.outletId)).rejects.toMatchObject({
      code: "OUTLET_OUT_OF_SCOPE",
    });
    expect(f.sim.calls.authorize).toBe(0);
  });
});
