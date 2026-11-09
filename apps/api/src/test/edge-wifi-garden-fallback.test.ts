// Edge Wi-Fi agent: empty walled-garden fallback (bead legend-hsk review 1,
// finding 4; sub-brief ws09-wifi-2 slice T).
//
// A walled-garden build failure (more than 100 hosts) must never stop
// renewals or downgrades (FAC-13: throttle, never cut). After an agent
// restart there is no last good list in memory, so the agent falls back to an
// empty list for the authorize call. That fallback is only a per-call value:
// it must never be synced to the controller, or it would wipe the pre-auth
// allowlist (FAC-11).
//
// Assumption: the fallback with no last good list is `[]` (the sub-brief says
// "renewals still go out with `[]`"). Only reconcile-driven renewals and
// downgrades are covered; a fresh apply with a failing build is not specified.
import { randomUUID } from "node:crypto";
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
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

const FULL = 10_000;
const BASE = 1_000;
const tenantIds: string[] = [];

const mac = () =>
  randomUUID().replace(/-/g, "").slice(0, 12).match(/../g)!.join(":");

/** One tenant and one controller simulator that outlive an agent restart. */
async function fixture() {
  const tenant = await createIsolatedTenant(`wgf-${randomUUID().slice(0, 8)}`);
  tenantIds.push(tenant.tenantId);
  let clock = new Date("2026-11-09T02:00:00.000Z");
  const now = () => new Date(clock);
  const sim = new WifiControllerSimulator({ now });
  const outletId = outletIdSchema.parse(tenant.outletId);
  const ctx: ScopedTenantContext = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletId] },
  );
  /** A new agent has no memory: this is what a process restart looks like. */
  const startAgent = () =>
    createWifiAgent({
      provider: sim,
      contextFor: (id: OutletId) => {
        if (id !== outletId) throw new Error("No node context for outlet");
        return ctx;
      },
      now,
      providerTimeoutMs: 2_000,
    });
  return {
    tenant,
    ctx,
    sim,
    outletId,
    startAgent,
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    input(overrides: Partial<ApplyWifiSessionInput>): ApplyWifiSessionInput {
      return {
        outletId,
        wifiSessionId: randomUUID(),
        controllerDeviceId: mac(),
        speedTier: "base",
        fullSpeedKbps: FULL,
        baseSpeedKbps: BASE,
        remainingSeconds: 0,
        sessionEndsAt: new Date(clock.getTime() + 12 * 3600_000).toISOString(),
        ...overrides,
      };
    },
    /** More than 100 hosts: the walled-garden build now throws. */
    async breakGardenBuild() {
      await owner.query(
        `INSERT INTO tenant_domains (tenant_id, brand_id, hostname, kind, tls_status, verified_at)
         SELECT $1, $2, 'h' || g || '-' || $3 || '.legend.test', 'custom', 'active', now()
         FROM generate_series(1, 101) AS g`,
        [tenant.tenantId, tenant.brandId, randomUUID().slice(0, 8)],
      );
    },
    access(deviceId: string) {
      return sim.deviceAccess(tenant.tenantId, tenant.outletId, deviceId);
    },
    reaches(host: string) {
      return sim.canReach(tenant.tenantId, tenant.outletId, null, host);
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

describe("edge Wi-Fi agent walled-garden fallback (legend-hsk)", () => {
  it("after a restart with a failing build and no last good list, a renewal goes out with [] and is never synced", async () => {
    const f = await fixture();
    const before = f.startAgent();
    const input = f.input({});
    await before.applySession(f.ctx, input);
    await before.reconcile(f.ctx, f.outletId);
    // The controller holds the good allowlist from the first agent.
    expect(f.sim.calls.syncWalledGarden).toBe(1);
    expect(f.reaches("pay.doit.id")).toBe(true);

    await f.breakGardenBuild();
    const after = f.startAgent();
    await expect(after.walledGarden(f.ctx)).rejects.toMatchObject({
      reason: "WIFI_WALLED_GARDEN_TOO_LARGE",
    });

    f.advance(
      WIFI_BASE_CHUNK_SECONDS +
        WIFI_FULL_GRACE_SECONDS -
        WIFI_RENEW_LEAD_SECONDS,
    );
    const result = await after.reconcile(f.ctx, f.outletId);
    expect(result.renewed).toBe(1);
    expect(result.failed).toBe(0);
    expect(f.sim.requests).toHaveLength(2);
    expect(f.sim.requests[1]!.walledGarden).toEqual([]);
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE,
      reference: f.sim.requests[1]!.reference,
    });

    // The empty fallback never reaches the controller, now or on later ticks.
    await after.reconcile(f.ctx, f.outletId);
    expect(f.sim.calls.syncWalledGarden).toBe(1);
    expect(f.reaches("pay.doit.id")).toBe(true);
    expect(f.sim.cuts()).toEqual([]);
  });

  it("after a restart with a failing build and no last good list, the quota-end downgrade still happens with []", async () => {
    const f = await fixture();
    const before = f.startAgent();
    const input = f.input({ speedTier: "full", remainingSeconds: 600 });
    await before.applySession(f.ctx, input);
    await before.reconcile(f.ctx, f.outletId);
    expect(f.sim.calls.syncWalledGarden).toBe(1);

    await f.breakGardenBuild();
    const after = f.startAgent();
    f.advance(600);
    const result = await after.reconcile(f.ctx, f.outletId);
    expect(result.downgraded).toBe(1);
    expect(f.sim.requests).toHaveLength(2);
    expect(f.sim.requests[1]!.walledGarden).toEqual([]);
    expect(f.access(input.controllerDeviceId)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE,
      reference: f.sim.requests[1]!.reference,
    });
    expect(f.sim.calls.syncWalledGarden).toBe(1);
    expect(f.reaches("pay.doit.id")).toBe(true);
    expect(f.sim.cuts()).toEqual([]);
  });
});
