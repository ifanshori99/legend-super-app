// WS-09 Wi-Fi acceptance (slice S5, plan docs/briefs/sub-ws09-wifi-plan.md §7).
// PRD §3 F5 + F25: FAC-11 (ordering and payment reachable from guest Wi-Fi
// without a Wi-Fi login), FAC-13 (a spent quota throttles to the base speed and
// never disconnects), FAC-15 smoke (300 devices, one reconcile tick stays
// bounded). Written from the plan and PRD, not from the implementation: real
// disposable PostgreSQL + WifiControllerSimulator + a fake clock.
//
// Assumptions (spec silent, recorded here and in the report):
// - The pre-auth allowlist reaches the controller through the agent's
//   `reconcile` (plan §4 step 6, `WifiWalledGardenSync`), so the FAC-11 tests
//   run one `reconcile` before probing an unauthenticated device.
// - A device the controller has never seen is not `online` (it is "blocked").
// - Controller ids are passed lowercase (the agent lowercases them anyway), so
//   simulator probes use the same lowercase form.
// - The ordering hosts are the tenant's `tenant_domains` hostnames plus the
//   hostnames (no port) of WEB_URL and BETTER_AUTH_URL; the payment hosts are
//   `PAYMENT_WALLED_GARDEN_HOSTS`.
// - `endSession` of a session unknown to the calling tenant either rejects or
//   returns no grants; the tests accept both and assert the other tenant's
//   device is untouched.
// - The loop tick in the simulated day is 120 s (the real one is 30 s); the
//   renew lead is 600 s and the grace 300 s, so a tick plus a 240 s pause stays
//   inside both.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { PAYMENT_WALLED_GARDEN_HOSTS } from "@starter/shared/edge";
import { WifiControllerSimulator } from "../edge/wifi/simulator.ts";
import {
  createWifiAgent,
  type WifiAgent,
} from "../services/edge-wifi-agent.service.ts";
import {
  createIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

const FULL_KBPS = 5000;
const BASE_KBPS = 1000;
const DAY_SECONDS = 36_000; // a 10 h opening day
const FOREIGN_HOST = "example.com";

class TestClock {
  private ms = Date.now();
  now = (): Date => new Date(this.ms);
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
  at(seconds: number): Date {
    return new Date(this.ms + seconds * 1000);
  }
}

type Fixture = {
  tenant: IsolatedTenant;
  clock: TestClock;
  sim: WifiControllerSimulator;
  agent: WifiAgent;
  ctx: ScopedTenantContext;
  outletId: OutletId;
};

function ctxFor(tenant: IsolatedTenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );
}

async function fixture(
  label: string,
  shared?: { clock: TestClock; sim: WifiControllerSimulator },
): Promise<Fixture> {
  const tenant = await createIsolatedTenant(
    `wifi-${label}-${randomUUID().slice(0, 6)}`,
  );
  tenantIds.push(tenant.tenantId);
  const clock = shared?.clock ?? new TestClock();
  const sim = shared?.sim ?? new WifiControllerSimulator({ now: clock.now });
  const ctx = ctxFor(tenant);
  const agent = createWifiAgent({
    provider: sim,
    contextFor: () => ctx,
    now: clock.now,
  });
  return {
    tenant,
    clock,
    sim,
    agent,
    ctx,
    outletId: outletIdSchema.parse(tenant.outletId),
  };
}

function mac(n: number): string {
  const hex = n.toString(16).padStart(6, "0");
  return `02:00:00:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`;
}

function applyInput(
  f: Fixture,
  input: {
    device: string;
    session?: string;
    tier: "full" | "base";
    remainingSeconds: number;
    endsInSeconds?: number;
  },
) {
  return {
    outletId: f.outletId,
    wifiSessionId: input.session ?? randomUUID(),
    controllerDeviceId: input.device,
    speedTier: input.tier,
    fullSpeedKbps: FULL_KBPS,
    baseSpeedKbps: BASE_KBPS,
    remainingSeconds: input.remainingSeconds,
    sessionEndsAt: f.clock.at(input.endsInSeconds ?? DAY_SECONDS).toISOString(),
  };
}

function hostOf(url: string | undefined, fallback: string): string {
  return new URL(url ?? fallback).hostname;
}

function orderingHosts(f: Fixture): string[] {
  return [
    f.tenant.hostname,
    hostOf(process.env.WEB_URL, "http://localhost:3101"),
    hostOf(process.env.BETTER_AUTH_URL, "http://localhost:4000"),
  ];
}

const paymentHosts: string[] = Object.values(
  PAYMENT_WALLED_GARDEN_HOSTS,
).flat();

function access(f: Fixture, device: string) {
  return f.sim.deviceAccess(f.tenant.tenantId, f.tenant.outletId, device);
}

function reach(f: Fixture, device: string | null, host: string) {
  return f.sim.canReach(f.tenant.tenantId, f.tenant.outletId, device, host);
}

type Tally = {
  authorized: number;
  downgraded: number;
  renewed: number;
  revoked: number;
  failed: number;
};

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  // Ledger and audit rows are retained; give the isolated tenants a valid
  // creator so the platform tenant list still parses them (as the EDC tests).
  await owner.query(
    "UPDATE tenants SET created_by = $2 WHERE id = ANY($1::uuid[])",
    [tenantIds, randomUUID()],
  );
  await owner.end();
});

describe("FAC-11 ordering and payment pages are reachable without a Wi-Fi login", () => {
  it("FAC-11 an unauthenticated device reaches every ordering and payment host, not example.com", async () => {
    const f = await fixture("fac11");
    await f.agent.reconcile(f.ctx, f.outletId);
    const device = mac(1);

    expect(access(f, device).state).not.toBe("online");
    for (const host of [...orderingHosts(f), ...paymentHosts]) {
      expect(reach(f, null, host), `no device -> ${host}`).toBe(true);
      expect(reach(f, device, host), `unauthenticated -> ${host}`).toBe(true);
    }
    expect(paymentHosts).toContain("pay.doit.id");
    expect(reach(f, null, FOREIGN_HOST)).toBe(false);
    expect(reach(f, device, FOREIGN_HOST)).toBe(false);
    expect(reach(f, device, `evil.${FOREIGN_HOST}`)).toBe(false);
  });

  it("FAC-11 the published walled garden lists the ordering and payment hosts", async () => {
    const f = await fixture("fac11list");
    const garden = await f.agent.walledGarden(f.ctx);
    for (const host of [...orderingHosts(f), ...paymentHosts])
      expect(garden.hosts).toContain(host);
    expect(garden.hosts).not.toContain(FOREIGN_HOST);
    expect([...garden.hosts].sort()).toEqual(garden.hosts);
    expect(garden.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("FAC-11 the hosts stay reachable after the guest is throttled to base and after the session ends", async () => {
    const f = await fixture("fac11throttle");
    await f.agent.reconcile(f.ctx, f.outletId);
    const device = mac(2);
    const session = randomUUID();
    await f.agent.applySession(
      f.ctx,
      applyInput(f, { device, session, tier: "full", remainingSeconds: 1800 }),
    );
    await f.agent.applySession(
      f.ctx,
      applyInput(f, { device, session, tier: "base", remainingSeconds: 0 }),
    );
    expect(access(f, device)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE_KBPS,
    });
    for (const host of [...orderingHosts(f), ...paymentHosts]) {
      expect(reach(f, device, host), `throttled -> ${host}`).toBe(true);
      expect(reach(f, null, host), `other device -> ${host}`).toBe(true);
    }

    await f.agent.endSession(f.ctx, {
      outletId: f.outletId,
      wifiSessionId: session,
      reason: "session_ended",
    });
    expect(access(f, device).state).toBe("blocked");
    for (const host of [...orderingHosts(f), ...paymentHosts])
      expect(reach(f, device, host), `ended -> ${host}`).toBe(true);
    expect(reach(f, device, FOREIGN_HOST)).toBe(false);
  });

  it("FAC-11 a guest of tenant A does not get tenant B's ordering host", async () => {
    const a = await fixture("fac11a");
    const b = await fixture("fac11b", { clock: a.clock, sim: a.sim });
    await a.agent.reconcile(a.ctx, a.outletId);
    await b.agent.reconcile(b.ctx, b.outletId);
    expect(reach(a, null, a.tenant.hostname)).toBe(true);
    expect(reach(a, null, b.tenant.hostname)).toBe(false);
    expect(reach(b, null, b.tenant.hostname)).toBe(true);
    expect(reach(b, null, a.tenant.hostname)).toBe(false);
  });
});

describe("FAC-13 a spent quota throttles and never disconnects", () => {
  it("FAC-13 a full simulated day with the loop paused 240 s twice never cuts the device", async () => {
    const f = await fixture("fac13day");
    const device = mac(10);
    const session = randomUUID();
    const tally: Tally = {
      authorized: 0,
      downgraded: 0,
      renewed: 0,
      revoked: 0,
      failed: 0,
    };

    const expectOnline = () => {
      const state = access(f, device);
      expect(state.state).toBe("online");
      return state as { state: "online"; bandwidthKbps: number };
    };
    const tick = async () => {
      const r = await f.agent.reconcile(f.ctx, f.outletId);
      for (const k of Object.keys(tally) as (keyof Tally)[]) tally[k] += r[k];
    };
    const advance = async (seconds: number, loop: boolean, step = 120) => {
      let left = seconds;
      while (left > 0) {
        const s = Math.min(step, left);
        f.clock.advance(s);
        left -= s;
        if (loop) await tick();
        expectOnline();
      }
    };

    // 30 minutes of full-speed quota left at the start of the day.
    const first = await f.agent.applySession(
      f.ctx,
      applyInput(f, { device, session, tier: "full", remainingSeconds: 1800 }),
    );
    expect(first).toMatchObject({
      speedTier: "full",
      bandwidthKbps: FULL_KBPS,
      status: "active",
    });
    expect(expectOnline().bandwidthKbps).toBe(FULL_KBPS);

    // Just before the quota runs out: still full speed.
    await advance(1700, true);
    expect(expectOnline().bandwidthKbps).toBe(FULL_KBPS);

    // Quota is spent at 1800 s; kmd3 never calls and the loop is paused for
    // 240 s (inside the 300 s grace of the full grant): the device stays on.
    await advance(240, false, 60);
    expect(expectOnline().bandwidthKbps).toBe(FULL_KBPS);

    // The loop resumes and downgrades to base without kmd3.
    await tick();
    expect(tally.downgraded).toBe(1);
    expect(expectOnline().bandwidthKbps).toBe(BASE_KBPS);
    let live = await f.agent.listLiveGrants(f.ctx, f.outletId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ speedTier: "base", status: "active" });
    expect(f.sim.cuts()).toEqual([]);

    // Base renewals through the day; a second 240 s pause sits right before
    // the first base grant enters its renewal window.
    await advance(15_900 - 1940, true);
    await advance(240, false, 60);
    await advance(DAY_SECONDS - 120 - (15_900 + 240), true);
    expect(tally.renewed).toBeGreaterThanOrEqual(1);
    expect(tally.failed).toBe(0);
    expect(expectOnline().bandwidthKbps).toBe(BASE_KBPS);
    live = await f.agent.listLiveGrants(f.ctx, f.outletId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ speedTier: "base", status: "active" });
    expect(f.sim.cuts()).toEqual([]);

    // Only the explicit end of the session blocks the device.
    const ended = await f.agent.endSession(f.ctx, {
      outletId: f.outletId,
      wifiSessionId: session,
      reason: "session_ended",
    });
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(access(f, device).state).toBe("blocked");
    expect(await f.agent.listLiveGrants(f.ctx, f.outletId)).toEqual([]);
    expect(f.sim.cuts()).toEqual([]);
  }, 120_000);

  it("FAC-13 when kmd3 reports the spent quota the device switches to base with no gap and outlives the old full grant", async () => {
    const f = await fixture("fac13kmd3");
    const device = mac(11);
    const session = randomUUID();
    await f.agent.applySession(
      f.ctx,
      applyInput(f, { device, session, tier: "full", remainingSeconds: 600 }),
    );
    expect(access(f, device)).toMatchObject({
      state: "online",
      bandwidthKbps: FULL_KBPS,
    });

    f.clock.advance(300);
    const base = await f.agent.applySession(
      f.ctx,
      applyInput(f, { device, session, tier: "base", remainingSeconds: 0 }),
    );
    expect(base).toMatchObject({ speedTier: "base", bandwidthKbps: BASE_KBPS });
    expect(access(f, device)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE_KBPS,
    });

    // Well past the old full grant's expiry (600 s + 300 s grace), no loop run.
    f.clock.advance(1200);
    expect(access(f, device)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE_KBPS,
    });
    expect(f.sim.cuts()).toEqual([]);
    const live = await f.agent.listLiveGrants(f.ctx, f.outletId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ speedTier: "base" });
  });

  it("FAC-13 a guest with no quota left still connects, at base speed", async () => {
    const f = await fixture("fac13zero");
    const device = mac(12);
    const grant = await f.agent.applySession(
      f.ctx,
      applyInput(f, { device, tier: "base", remainingSeconds: 0 }),
    );
    expect(grant).toMatchObject({ speedTier: "base", status: "active" });
    expect(access(f, device)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE_KBPS,
    });
  });
});

describe("two tenants on one database stay isolated end to end", () => {
  it("TEN-01 tenant B cannot see, end or affect tenant A's Wi-Fi sessions", async () => {
    const a = await fixture("isoa");
    const b = await fixture("isob", { clock: a.clock, sim: a.sim });
    const sharedDevice = mac(20); // the same physical MAC in two tenants
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    await a.agent.applySession(
      a.ctx,
      applyInput(a, {
        device: sharedDevice,
        session: sessionA,
        tier: "full",
        remainingSeconds: 3600,
      }),
    );
    // Same MAC in another tenant is a separate device: no WIFI_DEVICE_BOUND_ELSEWHERE.
    await b.agent.applySession(
      b.ctx,
      applyInput(b, {
        device: sharedDevice,
        session: sessionB,
        tier: "base",
        remainingSeconds: 0,
      }),
    );
    expect(access(a, sharedDevice)).toMatchObject({
      state: "online",
      bandwidthKbps: FULL_KBPS,
    });
    expect(access(b, sharedDevice)).toMatchObject({
      state: "online",
      bandwidthKbps: BASE_KBPS,
    });

    const liveA = await a.agent.listLiveGrants(a.ctx, a.outletId);
    const liveB = await b.agent.listLiveGrants(b.ctx, b.outletId);
    expect(liveA.map((g) => g.wifiSessionId)).toEqual([sessionA]);
    expect(liveB.map((g) => g.wifiSessionId)).toEqual([sessionB]);
    expect(liveA.every((g) => g.tenantId === a.tenant.tenantId)).toBe(true);
    expect(liveB.every((g) => g.tenantId === b.tenant.tenantId)).toBe(true);
    // No raw controller id in a view.
    expect(JSON.stringify([...liveA, ...liveB])).not.toContain(sharedDevice);

    // B tries to end A's session: nothing of A changes.
    await b.agent
      .endSession(b.ctx, {
        outletId: b.outletId,
        wifiSessionId: sessionA,
        reason: "staff_revoked",
      })
      .then(
        (grants) => expect(grants).toEqual([]),
        () => undefined,
      );
    expect(access(a, sharedDevice).state).toBe("online");
    expect(access(b, sharedDevice).state).toBe("online");
    expect(await a.agent.listLiveGrants(a.ctx, a.outletId)).toHaveLength(1);

    // B's context cannot read or end A's outlet.
    await expect(
      a.agent.listLiveGrants(b.ctx, a.outletId),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      a.agent.endSession(b.ctx, {
        outletId: a.outletId,
        wifiSessionId: sessionA,
        reason: "staff_revoked",
      }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    expect(access(a, sharedDevice).state).toBe("online");

    // A's staff ending A's session leaves B's device on.
    await a.agent.endSession(a.ctx, {
      outletId: a.outletId,
      wifiSessionId: sessionA,
      reason: "staff_revoked",
    });
    expect(access(a, sharedDevice).state).toBe("blocked");
    expect(access(b, sharedDevice).state).toBe("online");
    expect(await b.agent.listLiveGrants(b.ctx, b.outletId)).toHaveLength(1);
  });
});

describe("FAC-15 smoke: 300 devices and one reconcile tick", () => {
  it("FAC-15 a reconcile tick touches at most 100 rows and 300 devices converge with no cut", async () => {
    const f = await fixture("fac15");
    const devices = Array.from({ length: 300 }, (_, i) => mac(1000 + i));
    for (let i = 0; i < devices.length; i += 25) {
      await Promise.all(
        devices.slice(i, i + 25).map((device) =>
          f.agent.applySession(
            f.ctx,
            // 60 s of full quota left: due for downgrade after 60 s.
            applyInput(f, { device, tier: "full", remainingSeconds: 60 }),
          ),
        ),
      );
    }
    expect(await f.agent.listLiveGrants(f.ctx, f.outletId)).toHaveLength(300);
    expect(devices.every((d) => access(f, d).state === "online")).toBe(true);

    f.clock.advance(90); // every full grant is now in its downgrade window
    const first = await f.agent.reconcile(f.ctx, f.outletId);
    const touched =
      first.authorized +
      first.downgraded +
      first.renewed +
      first.revoked +
      first.failed;
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThanOrEqual(100);
    expect(first.failed).toBe(0);

    // More ticks drain the rest, each bounded, nobody cut.
    for (let tick = 0; tick < 6; tick += 1) {
      const r = await f.agent.reconcile(f.ctx, f.outletId);
      expect(
        r.authorized + r.downgraded + r.renewed + r.revoked + r.failed,
      ).toBeLessThanOrEqual(100);
    }
    const live = await f.agent.listLiveGrants(f.ctx, f.outletId);
    expect(live).toHaveLength(300);
    expect(live.every((g) => g.speedTier === "base")).toBe(true);
    expect(devices.every((d) => access(f, d).state === "online")).toBe(true);
    expect(f.sim.cuts()).toEqual([]);
  }, 180_000);
});
